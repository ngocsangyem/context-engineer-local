/**
 * Single-file indexing pipeline: read → hash-check → AST-chunk → embed → store vectors → update metadata.
 * Extracted from IndexerOrchestrator to keep each module under 200 lines.
 */

import fs from 'fs';
import { chunkFile, type SymbolTag, type CodeChunk } from './ast-chunker.js';
import { generateEmbeddings } from './embedding-generator.js';
import { hashContent, hasContentChanged } from './content-hasher.js';
import type { LanceVectorStore } from '../storage/lance-vector-store.js';
import type { MetadataStore } from '../storage/metadata-store.js';
import type { ScannedFile } from './file-scanner.js';

export interface FileProcessResult {
  tags: SymbolTag[];
  chunkCount: number;
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
  let chunks: CodeChunk[];
  let tags: SymbolTag[];
  try {
    const result = await chunkFile(file.path, content, language ?? 'text');
    chunks = result.chunks;
    tags = result.tags;
  } catch (err) {
    process.stderr.write(`Warning: chunking failed for ${file.path}: ${err}\n`);
    return null;
  }

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

  // Update metadata
  metadataStore.setFileMetadata(file.path, hash, chunks.length, language ?? '');

  return { tags, chunkCount: chunks.length };
}
