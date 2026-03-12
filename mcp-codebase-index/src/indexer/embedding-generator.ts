/**
 * Generates semantic embeddings for code chunks using a worker-thread ONNX pool.
 * Model: all-MiniLM-L6-v2 (384-dimensional embeddings).
 *
 * On first call, lazily initializes an EmbeddingPool (spawns worker threads).
 * Falls back to deterministic placeholder embeddings if all workers fail.
 *
 * Call shutdownEmbeddingPool() before process exit for clean worker teardown.
 */

import { createHash } from 'crypto';
import { EmbeddingPool } from './embedding-pool.js';

const EMBEDDING_DIM = 384;
const BATCH_SIZE = 32;

/** Pool singleton — lazy-initialized on first generateEmbeddings() call. */
let pool: EmbeddingPool | null = null;
let poolInitPromise: Promise<void> | null = null;
let configuredPoolSize: number | undefined;

/**
 * Configure embedding pool size before first use.
 * Must be called before generateEmbeddings() / embedText() to take effect.
 * If not called, defaults to min(4, cpu count).
 */
export function configureEmbeddingPool(opts: { poolSize?: number }): void {
  if (pool !== null || poolInitPromise !== null) {
    process.stderr.write('[embedding-generator] Warning: configureEmbeddingPool() called after pool already initialized — ignoring.\n');
    return;
  }
  configuredPoolSize = opts.poolSize;
}

async function ensurePool(): Promise<void> {
  if (pool !== null) return;
  if (poolInitPromise) { await poolInitPromise; return; }

  poolInitPromise = (async () => {
    const p = new EmbeddingPool(configuredPoolSize);
    await p.init();
    pool = p;
    process.stderr.write('[embedding-generator] Worker pool ready.\n');
  })().catch((err) => {
    process.stderr.write(`[embedding-generator] Pool init failed, using placeholders: ${err}\n`);
    pool = null;
  });

  await poolInitPromise;
}

// ---------------------------------------------------------------------------
// Placeholder fallback (used when pool is unavailable)
// ---------------------------------------------------------------------------

function placeholderEmbedding(text: string): Float32Array {
  const embedding = new Float32Array(EMBEDDING_DIM);
  const hash = createHash('sha256').update(text).digest();
  for (let i = 0; i < EMBEDDING_DIM; i++) {
    embedding[i] = (hash[i % hash.length] / 127.5) - 1.0;
  }
  const norm = Math.sqrt(embedding.reduce((s, v) => s + v * v, 0));
  if (norm > 0) for (let i = 0; i < EMBEDDING_DIM; i++) embedding[i] /= norm;
  return embedding;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Batch-encode texts into 384-dim embeddings via worker pool.
 * Processes in BATCH_SIZE chunks to control memory.
 */
export async function generateEmbeddings(texts: string[]): Promise<Float32Array[]> {
  await ensurePool();

  const results: Float32Array[] = [];

  for (let start = 0; start < texts.length; start += BATCH_SIZE) {
    const batch = texts.slice(start, start + BATCH_SIZE);

    if (pool) {
      try {
        const batchEmbeddings = await pool.embed(batch);
        results.push(...batchEmbeddings);
        continue;
      } catch (err) {
        process.stderr.write(`[embedding-generator] Pool embed failed, using placeholders: ${err}\n`);
      }
    }

    // Fallback for this batch
    results.push(...batch.map(placeholderEmbedding));
  }

  return results;
}

/**
 * Embed a single string (convenience wrapper).
 */
export async function embedText(text: string): Promise<Float32Array> {
  await ensurePool();

  if (pool) {
    try {
      const [embedding] = await pool.embed([text]);
      return embedding;
    } catch {
      // fall through to placeholder
    }
  }

  return placeholderEmbedding(text);
}

/**
 * Terminate all worker threads. Call before process exit.
 */
export async function shutdownEmbeddingPool(): Promise<void> {
  if (pool) {
    await pool.shutdown();
    pool = null;
  }
}

/** Embedding vector dimension (all-MiniLM-L6-v2 outputs 384 dims). */
export const VECTOR_DIM = EMBEDDING_DIM;
