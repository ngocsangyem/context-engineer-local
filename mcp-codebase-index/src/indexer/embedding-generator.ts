/**
 * Generates semantic embeddings for code chunks using ONNX runtime.
 * Model: all-MiniLM-L6-v2 (384-dimensional embeddings).
 *
 * NOTE: The ONNX model file must be present at runtime.
 * If the model is unavailable, falls back to deterministic pseudo-random embeddings
 * (TODO: replace with real model download in production setup).
 */

import { createHash } from 'crypto';

const EMBEDDING_DIM = 384;
const BATCH_SIZE = 32;

// Lazy-loaded ONNX session — only initialized on first call
let ortSession: OrtSession | null = null;
let onnxAvailable = false;
let onnxInitAttempted = false;

// Minimal type shim for onnxruntime-node (avoids import errors if pkg missing)
interface OrtTensor {
  data: Float32Array;
  dims: number[];
}
interface OrtSession {
  run(feeds: Record<string, OrtTensor>): Promise<Record<string, OrtTensor>>;
}

/**
 * Try to load the ONNX session once.
 * Silently marks onnxAvailable=false if model or package is missing.
 */
async function ensureModel(): Promise<void> {
  if (onnxInitAttempted) return;
  onnxInitAttempted = true;

  try {
    // Dynamic import so the server still starts if onnxruntime-node is absent
    const ort = await import('onnxruntime-node');
    // Model should be at <package_root>/models/all-MiniLM-L6-v2.onnx
    const modelPath = new URL('../../models/all-MiniLM-L6-v2.onnx', import.meta.url);
    ortSession = await ort.InferenceSession.create(modelPath.pathname) as unknown as OrtSession;
    onnxAvailable = true;
    process.stderr.write('Embedding model loaded via ONNX runtime.\n');
  } catch {
    onnxAvailable = false;
    process.stderr.write(
      'Warning: ONNX model unavailable — using placeholder embeddings. ' +
      'Place all-MiniLM-L6-v2.onnx in models/ for real embeddings.\n'
    );
  }
}

/**
 * Simple whitespace tokenizer returning token IDs.
 * Used for mean-pooling placeholder when real tokenizer is absent.
 */
function naiveTokenize(text: string): number[] {
  return text
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => {
      let hash = 0;
      for (let i = 0; i < w.length; i++) hash = (hash * 31 + w.charCodeAt(i)) & 0xffff;
      return hash % 30522; // BERT vocab size
    });
}

/**
 * Generate a deterministic placeholder embedding from text.
 * Produces a stable 384-dim Float32Array derived from the content hash.
 * This is a fallback — NOT a real semantic embedding.
 */
function placeholderEmbedding(text: string): Float32Array {
  const embedding = new Float32Array(EMBEDDING_DIM);
  const hash = createHash('sha256').update(text).digest();

  // Seed the embedding with hash bytes, then normalize
  for (let i = 0; i < EMBEDDING_DIM; i++) {
    const byte = hash[i % hash.length];
    embedding[i] = (byte / 127.5) - 1.0; // range [-1, 1]
  }

  // L2 normalize
  const norm = Math.sqrt(embedding.reduce((s, v) => s + v * v, 0));
  if (norm > 0) {
    for (let i = 0; i < EMBEDDING_DIM; i++) embedding[i] /= norm;
  }

  return embedding;
}

/**
 * Run mean pooling on token embeddings tensor.
 * @param tokenEmbeddings Float32Array of shape [seqLen, hiddenDim]
 * @param seqLen Number of tokens
 * @param hiddenDim Embedding dimension (384)
 */
function meanPool(tokenEmbeddings: Float32Array, seqLen: number, hiddenDim: number): Float32Array {
  const pooled = new Float32Array(hiddenDim);
  for (let i = 0; i < seqLen; i++) {
    for (let j = 0; j < hiddenDim; j++) {
      pooled[j] += tokenEmbeddings[i * hiddenDim + j];
    }
  }
  for (let j = 0; j < hiddenDim; j++) pooled[j] /= seqLen;

  // L2 normalize
  const norm = Math.sqrt(pooled.reduce((s, v) => s + v * v, 0));
  if (norm > 0) for (let j = 0; j < hiddenDim; j++) pooled[j] /= norm;

  return pooled;
}

/**
 * Embed a single text string via ONNX or placeholder fallback.
 */
async function embedOne(text: string): Promise<Float32Array> {
  if (!onnxAvailable || ortSession === null) {
    return placeholderEmbedding(text);
  }

  try {
    const ort = await import('onnxruntime-node');
    const tokens = naiveTokenize(text).slice(0, 512);
    const seqLen = tokens.length || 1;

    const inputIds = new BigInt64Array(tokens.map(BigInt));
    const attentionMask = new BigInt64Array(seqLen).fill(1n);
    const tokenTypeIds = new BigInt64Array(seqLen).fill(0n);

    const feeds = {
      input_ids: new ort.Tensor('int64', inputIds, [1, seqLen]),
      attention_mask: new ort.Tensor('int64', attentionMask, [1, seqLen]),
      token_type_ids: new ort.Tensor('int64', tokenTypeIds, [1, seqLen]),
    };

    const output = await ortSession.run(feeds as never);
    const lastHiddenState = output['last_hidden_state'] ?? output[Object.keys(output)[0]];
    return meanPool(lastHiddenState.data as Float32Array, seqLen, EMBEDDING_DIM);
  } catch (err) {
    process.stderr.write(`Warning: ONNX inference failed, using placeholder: ${err}\n`);
    return placeholderEmbedding(text);
  }
}

/**
 * Batch-encode an array of texts into 384-dim embeddings.
 * Processes in batches of BATCH_SIZE to manage memory.
 *
 * @param texts Array of text strings to embed
 * @returns Array of Float32Array embeddings (same order as input)
 */
export async function generateEmbeddings(texts: string[]): Promise<Float32Array[]> {
  await ensureModel();

  const results: Float32Array[] = [];

  for (let start = 0; start < texts.length; start += BATCH_SIZE) {
    const batch = texts.slice(start, start + BATCH_SIZE);
    const batchEmbeddings = await Promise.all(batch.map(embedOne));
    results.push(...batchEmbeddings);
  }

  return results;
}

/**
 * Embed a single string (convenience wrapper).
 */
export async function embedText(text: string): Promise<Float32Array> {
  await ensureModel();
  return embedOne(text);
}

/** Embedding vector dimension (all-MiniLM-L6-v2 outputs 384 dims). */
export const VECTOR_DIM = EMBEDDING_DIM;
