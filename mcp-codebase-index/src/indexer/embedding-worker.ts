/**
 * Worker thread for ONNX-based text embedding.
 * Loaded by EmbeddingPool; handles one embed request at a time.
 *
 * Protocol (parent ↔ worker):
 *   parent → worker: { type: 'embed', id: number, texts: string[] }
 *   worker → parent: { type: 'result', id: number, embeddings: ArrayBuffer[] }
 *                  | { type: 'error', id: number, message: string }
 *                  | { type: 'ready' }
 */

import { parentPort } from 'worker_threads';
import { createHash } from 'crypto';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';

const EMBEDDING_DIM = 384;

// ---------------------------------------------------------------------------
// Utility: path resolution relative to compiled dist/ output
// ---------------------------------------------------------------------------

/**
 * Resolves model path, preferring quantized INT8 variant over FP32.
 * Returns { modelPath, variant } where variant is 'int8' | 'fp32'.
 */
function resolveModelPath(): { modelPath: string; variant: 'int8' | 'fp32' } {
  // import.meta.url points to dist/indexer/embedding-worker.js at runtime
  const thisFile = fileURLToPath(import.meta.url);
  const distDir = dirname(dirname(thisFile)); // dist/
  const modelsDir = join(distDir, 'models');

  const int8Path = join(modelsDir, 'all-MiniLM-L6-v2-quantized.onnx');
  const fp32Path = join(modelsDir, 'all-MiniLM-L6-v2.onnx');

  // Prefer quantized INT8 model when available
  if (existsSync(int8Path)) {
    return { modelPath: int8Path, variant: 'int8' };
  }
  return { modelPath: fp32Path, variant: 'fp32' };
}

// ---------------------------------------------------------------------------
// Minimal type shim for onnxruntime-node
// ---------------------------------------------------------------------------

interface OrtTensor { data: Float32Array; dims: number[] }
interface OrtSession {
  run(feeds: Record<string, OrtTensor>): Promise<Record<string, OrtTensor>>;
}

let ortSession: OrtSession | null = null;
let onnxAvailable = false;
let cachedOrt: typeof import('onnxruntime-node') | null = null;

// ---------------------------------------------------------------------------
// Shared math helpers (duplicated from embedding-generator to keep worker self-contained)
// ---------------------------------------------------------------------------

function naiveTokenize(text: string): number[] {
  return text
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => {
      let hash = 0;
      for (let i = 0; i < w.length; i++) hash = (hash * 31 + w.charCodeAt(i)) & 0xffff;
      return hash % 30522;
    });
}

function meanPool(tokenEmbeddings: Float32Array, seqLen: number, hiddenDim: number): Float32Array {
  const pooled = new Float32Array(hiddenDim);
  for (let i = 0; i < seqLen; i++) {
    for (let j = 0; j < hiddenDim; j++) pooled[j] += tokenEmbeddings[i * hiddenDim + j];
  }
  for (let j = 0; j < hiddenDim; j++) pooled[j] /= seqLen;
  const norm = Math.sqrt(pooled.reduce((s, v) => s + v * v, 0));
  if (norm > 0) for (let j = 0; j < hiddenDim; j++) pooled[j] /= norm;
  return pooled;
}

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
// Embed a single text
// ---------------------------------------------------------------------------

async function embedOne(text: string): Promise<Float32Array> {
  if (!onnxAvailable || ortSession === null) return placeholderEmbedding(text);

  try {
    const ort = cachedOrt!;
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
  } catch {
    return placeholderEmbedding(text);
  }
}

// ---------------------------------------------------------------------------
// Startup: load model then signal ready
// ---------------------------------------------------------------------------

async function init(): Promise<void> {
  if (!parentPort) throw new Error('Must run as worker thread');

  try {
    cachedOrt = await import('onnxruntime-node');
    const ort = cachedOrt;
    const { modelPath, variant } = resolveModelPath();
    ortSession = await ort.InferenceSession.create(modelPath, {
      executionProviders: ['cpu'],
      graphOptimizationLevel: 'all',
      enableCpuMemArena: true,
      enableMemPattern: true,
      interOpNumThreads: 1,   // one thread per worker — avoids cross-worker contention
      intraOpNumThreads: 1,   // single-threaded ops; pool provides parallelism
    }) as unknown as OrtSession;
    onnxAvailable = true;
    process.stderr.write(`[embedding-worker] Loaded ${variant} model: ${modelPath}\n`);
  } catch (err) {
    process.stderr.write(`[embedding-worker] ONNX load failed, using placeholders: ${err}\n`);
    onnxAvailable = false;
  }

  parentPort.postMessage({ type: 'ready' });

  // Message loop
  parentPort.on('message', async (msg: { type: string; id: number; texts: string[] }) => {
    if (msg.type !== 'embed') return;
    try {
      const embeddings = await Promise.all(msg.texts.map(embedOne));
      const buffers = embeddings.map((e) => e.buffer as ArrayBuffer);
      parentPort!.postMessage({ type: 'result', id: msg.id, embeddings: buffers }, buffers);
    } catch (err) {
      parentPort!.postMessage({ type: 'error', id: msg.id, message: String(err) });
    }
  });
}

init().catch((err) => {
  parentPort?.postMessage({ type: 'error', id: -1, message: String(err) });
  process.exit(1);
});
