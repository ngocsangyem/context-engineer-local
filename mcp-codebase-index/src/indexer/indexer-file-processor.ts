/**
 * Single-file indexing pipeline: read → hash-check → AST-chunk → embed → store vectors → update metadata.
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
import type { LanceVectorStore } from '../storage/lance-vector-store.js';
import type { MetadataStore } from '../storage/metadata-store.js';
import type { ScannedFile } from './file-scanner.js';
import type { SymbolRecord } from '../models/symbol.js';

export interface FileProcessResult {
  tags: SymbolTag[];
  chunkCount: number;
  symbols: SymbolRecord[];
}

/**
 * Process a single file through the indexing pipeline.
 * Returns null if the file is unchanged (skipped).
 */
export async function processFile(
  file: ScannedFile,
  vectorStore: LanceVectorStore,
  metadataStore: MetadataStore,
  force = false
): Promise<FileProcessResult | null> {
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

  const language = file.language;

  // Parse AST and extract chunks + tags
  let result: Awaited<ReturnType<typeof chunkFile>>;
  try {
    result = await chunkFile(file.path, content, language ?? 'text');
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

  // Store vectors
  try {
    await vectorStore.upsert(chunks, embeddings);
  } catch (err) {
    process.stderr.write(`Warning: vector store upsert failed for ${file.path}: ${err}\n`);
    return null;
  }

  // Extract rich symbols from AST (if tree was parsed)
  let symbols: SymbolRecord[] = [];
  if (result.rootNode) {
    try {
      symbols = extractSymbols(result.rootNode, file.path, language ?? 'text', content);
      metadataStore.upsertSymbols(file.path, symbols);
    } catch (err) {
      process.stderr.write(`Warning: symbol extraction failed for ${file.path}: ${err}\n`);
    }

    // Parse import statements and persist dependency edges
    try {
      const rawImports = parseImports(result.rootNode, language ?? '');
      const edges = resolveImports(file.path, rawImports);
      metadataStore.upsertEdges(file.path, edges);
    } catch (err) {
      process.stderr.write(`Warning: import parsing failed for ${file.path}: ${err}\n`);
    }

    // Extract call edges (unresolved — records caller→callee name without file resolution)
    try {
      const callEdges = extractCallEdges(result.rootNode, file.path, symbols);
      metadataStore.upsertCallEdges(file.path, callEdges);
    } catch (err) {
      process.stderr.write(`Warning: call graph extraction failed for ${file.path}: ${err}\n`);
    }
  }

  // Update metadata
  metadataStore.setFileMetadata(file.path, hash, chunks.length, language ?? '');

  return { tags, chunkCount: chunks.length, symbols };
}
