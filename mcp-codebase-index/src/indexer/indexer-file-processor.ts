/**
 * Single-file indexing pipeline: read → hash-check → AST-chunk → embed → extract symbols/edges.
 * Returns raw data for the orchestrator to batch-write to stores.
 * Extracted from IndexerOrchestrator to keep each module under 200 lines.
 */

import fs from 'fs';
import { chunkFile, type SymbolTag, type CodeChunk } from './ast-chunker.js';
import { extractSymbols } from './symbol-extractor.js';
import { generateEmbeddings } from './embedding-generator.js';
import { hashContent, hasContentChanged } from './content-hasher.js';
import { parseImports } from './import-parser.js';
import { resolveImports } from './import-resolver.js';
import { extractCallEdges } from './call-graph-builder.js';
import type { MetadataStore, DependencyEdge, CallEdge } from '../storage/metadata-store.js';
import type { ScannedFile } from './file-scanner.js';
import type { SymbolRecord } from '../models/symbol.js';

/** Raw output returned by processFile — no store writes performed. */
export interface FileProcessOutput {
  filePath: string;
  hash: string;
  chunkCount: number;
  language: string;
  symbols: SymbolRecord[];
  edges: Omit<DependencyEdge, 'fromFile'>[];
  callEdges: Omit<CallEdge, 'calleeFile'>[];
  chunks: CodeChunk[];
  embeddings: Float32Array[];
  tags: SymbolTag[];
}

/**
 * Process a single file through the indexing pipeline.
 * Returns raw data (no store writes). Returns null if file is unchanged or on error.
 */
export async function processFile(
  file: ScannedFile,
  metadataStore: MetadataStore,
  force = false
): Promise<FileProcessOutput | null> {
  let content: string;
  try {
    content = fs.readFileSync(file.path, 'utf-8');
  } catch (err) {
    process.stderr.write(`Warning: cannot read ${file.path}: ${err}\n`);
    return null;
  }

  const hash = hashContent(content);
  const storedHash = metadataStore.getFileHash(file.path);

  // Skip unchanged files unless force=true
  if (!force && !hasContentChanged(content, storedHash)) {
    return null;
  }

  const language = file.language ?? '';

  // Parse AST and extract chunks + tags
  let result: Awaited<ReturnType<typeof chunkFile>>;
  try {
    result = await chunkFile(file.path, content, language || 'text');
  } catch (err) {
    process.stderr.write(`Warning: chunking failed for ${file.path}: ${err}\n`);
    return null;
  }

  const { chunks, tags } = result;
  if (chunks.length === 0) return null;

  // Generate embeddings
  const texts = chunks.map((c) => `${c.signature}\n${c.content}`.slice(0, 2000));
  let embeddings: Float32Array[];
  try {
    embeddings = await generateEmbeddings(texts);
  } catch (err) {
    process.stderr.write(`Warning: embedding failed for ${file.path}: ${err}\n`);
    return null;
  }

  // Extract symbols, edges, and call edges (no store writes)
  let symbols: SymbolRecord[] = [];
  let edges: Omit<DependencyEdge, 'fromFile'>[] = [];
  let callEdges: Omit<CallEdge, 'calleeFile'>[] = [];

  if (result.rootNode) {
    try {
      symbols = extractSymbols(result.rootNode, file.path, language, content);
    } catch (err) {
      process.stderr.write(`Warning: symbol extraction failed for ${file.path}: ${err}\n`);
    }

    try {
      const rawImports = parseImports(result.rootNode, language);
      edges = resolveImports(file.path, rawImports);
    } catch (err) {
      process.stderr.write(`Warning: import parsing failed for ${file.path}: ${err}\n`);
    }

    try {
      callEdges = extractCallEdges(result.rootNode, file.path, symbols);
    } catch (err) {
      process.stderr.write(`Warning: call graph extraction failed for ${file.path}: ${err}\n`);
    }
  }

  return {
    filePath: file.path,
    hash,
    chunkCount: chunks.length,
    language,
    symbols,
    edges,
    callEdges,
    chunks,
    embeddings,
    tags,
  };
}
