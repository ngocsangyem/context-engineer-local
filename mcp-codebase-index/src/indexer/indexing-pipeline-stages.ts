/**
 * Node.js Transform/Writable stream stages for the 3-stage concurrent indexing pipeline.
 * Parse → Embed → Store. Files flow through without waiting for all files to be scanned first.
 * Extracted to keep each module under 200 lines.
 */

import { Transform, Writable } from 'stream';
import type { TransformCallback, TransformOptions } from 'stream';
import fs from 'fs';
import { chunkFile } from './ast-chunker.js';
import { generateEmbeddings } from './embedding-generator.js';
import { hashContent, hasContentChanged } from './content-hasher.js';
import { extractSymbols } from './symbol-extractor.js';
import { parseImports } from './import-parser.js';
import { resolveImports } from './import-resolver.js';
import { extractCallEdges } from './call-graph-builder.js';
import type { SymbolTag, CodeChunk } from './ast-chunker.js';
import type { MetadataStore, DependencyEdge, CallEdge } from '../storage/metadata-store.js';
import type { LanceVectorStore } from '../storage/lance-vector-store.js';
import type { TagGraphStore } from '../storage/tag-graph-store.js';
import type { SymbolRecord } from '../models/symbol.js';
import type { ScannedFile } from './file-scanner.js';

// ---------------------------------------------------------------------------
// Shared types for pipeline stages
// ---------------------------------------------------------------------------

export interface ParsedFileData {
  filePath: string;
  hash: string;
  language: string;
  chunks: CodeChunk[];
  tags: SymbolTag[];
  symbols: SymbolRecord[];
  edges: Omit<DependencyEdge, 'fromFile'>[];
  callEdges: Omit<CallEdge, 'calleeFile'>[];
}

export interface EmbeddedFileData extends ParsedFileData {
  embeddings: Float32Array[];
}

export interface PipelineStats {
  indexedFiles: number;
  totalChunks: number;
  tags: SymbolTag[];
}

// ---------------------------------------------------------------------------
// Stage 1: ParseTransform
// ---------------------------------------------------------------------------

export class ParseTransform extends Transform {
  private readonly metadataStore: MetadataStore;
  private readonly force: boolean;

  constructor(metadataStore: MetadataStore, force: boolean, opts?: TransformOptions) {
    super({ ...opts, objectMode: true, highWaterMark: 8 });
    this.metadataStore = metadataStore;
    this.force = force;
  }

  _transform(file: ScannedFile, _encoding: string, callback: TransformCallback): void {
    this._parseFile(file)
      .then((parsed) => {
        if (parsed !== null) this.push(parsed);
        callback();
      })
      .catch((err) => {
        process.stderr.write(`[pipeline:parse] Error for ${file.path}: ${err}\n`);
        callback(); // skip file, continue pipeline
      });
  }

  private async _parseFile(file: ScannedFile): Promise<ParsedFileData | null> {
    let content: string;
    try {
      content = fs.readFileSync(file.path, 'utf-8');
    } catch (err) {
      process.stderr.write(`[pipeline:parse] Cannot read ${file.path}: ${err}\n`);
      return null;
    }

    const hash = hashContent(content);
    const storedHash = this.metadataStore.getFileHash(file.path);
    if (!this.force && !hasContentChanged(content, storedHash)) return null;

    const language = file.language ?? '';

    let chunks: CodeChunk[];
    let tags: SymbolTag[];
    let rootNode: unknown;
    try {
      const result = await chunkFile(file.path, content, language || 'text');
      chunks = result.chunks;
      tags = result.tags;
      rootNode = result.rootNode;
    } catch (err) {
      process.stderr.write(`[pipeline:parse] Chunking failed for ${file.path}: ${err}\n`);
      return null;
    }

    if (chunks.length === 0) return null;

    let symbols: SymbolRecord[] = [];
    let edges: Omit<DependencyEdge, 'fromFile'>[] = [];
    let callEdges: Omit<CallEdge, 'calleeFile'>[] = [];

    if (rootNode) {
      try { symbols = extractSymbols(rootNode as Parameters<typeof extractSymbols>[0], file.path, language, content); } catch { /* skip */ }
      try { const raw = parseImports(rootNode as Parameters<typeof parseImports>[0], language); edges = resolveImports(file.path, raw); } catch { /* skip */ }
      try { callEdges = extractCallEdges(rootNode as Parameters<typeof extractCallEdges>[0], file.path, symbols); } catch { /* skip */ }
    }

    return { filePath: file.path, hash, language, chunks, tags, symbols, edges, callEdges };
  }
}

// ---------------------------------------------------------------------------
// Stage 2: EmbedTransform
// ---------------------------------------------------------------------------

export class EmbedTransform extends Transform {
  constructor(opts?: TransformOptions) {
    super({ ...opts, objectMode: true, highWaterMark: 4 });
  }

  _transform(data: ParsedFileData, _encoding: string, callback: TransformCallback): void {
    this._embedFile(data)
      .then((embedded) => {
        if (embedded !== null) this.push(embedded);
        callback();
      })
      .catch((err) => {
        process.stderr.write(`[pipeline:embed] Error for ${data.filePath}: ${err}\n`);
        callback();
      });
  }

  private async _embedFile(data: ParsedFileData): Promise<EmbeddedFileData | null> {
    const texts = data.chunks.map((c) => `${c.signature}\n${c.content}`.slice(0, 2000));
    let embeddings: Float32Array[];
    try {
      embeddings = await generateEmbeddings(texts);
    } catch (err) {
      process.stderr.write(`[pipeline:embed] Embedding failed for ${data.filePath}: ${err}\n`);
      return null;
    }
    return { ...data, embeddings };
  }
}

// ---------------------------------------------------------------------------
// Stage 3: StoreWritable
// ---------------------------------------------------------------------------

const STORE_BATCH_SIZE = 50;

export class StoreWritable extends Writable {
  private readonly metadataStore: MetadataStore;
  private readonly vectorStore: LanceVectorStore;
  private readonly tagGraph: TagGraphStore;

  private batch: EmbeddedFileData[] = [];
  readonly collectedTags: SymbolTag[] = [];
  indexedFiles = 0;
  totalChunks = 0;

  constructor(
    metadataStore: MetadataStore,
    vectorStore: LanceVectorStore,
    tagGraph: TagGraphStore
  ) {
    super({ objectMode: true, highWaterMark: 16 });
    this.metadataStore = metadataStore;
    this.vectorStore = vectorStore;
    this.tagGraph = tagGraph;
  }

  _write(data: EmbeddedFileData, _encoding: string, callback: (err?: Error | null) => void): void {
    this.batch.push(data);
    this.collectedTags.push(...data.tags);
    this.indexedFiles++;
    this.totalChunks += data.chunks.length;

    if (this.batch.length >= STORE_BATCH_SIZE) {
      this._flushBatch()
        .then(() => callback())
        .catch((err) => callback(err));
    } else {
      callback();
    }
  }

  _final(callback: (err?: Error | null) => void): void {
    this._flushBatch()
      .then(() => callback())
      .catch((err) => callback(err));
  }

  private async _flushBatch(): Promise<void> {
    if (this.batch.length === 0) return;
    const toFlush = this.batch;
    this.batch = [];

    await this.vectorStore.batchUpsert(
      toFlush.map((r) => ({ chunks: r.chunks, embeddings: r.embeddings }))
    );

    this.metadataStore.batchWriteFileResults(
      toFlush.map((r) => ({
        filePath: r.filePath,
        hash: r.hash,
        chunkCount: r.chunks.length,
        language: r.language,
        symbols: r.symbols,
        edges: r.edges,
        callEdges: r.callEdges,
      }))
    );
  }
}
