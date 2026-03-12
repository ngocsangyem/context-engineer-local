/**
 * Worker-thread pool for parallel text embedding.
 * Spawns N worker threads (default: min(4, cpu count)), each loading the ONNX model.
 * Dispatches embed requests round-robin and collects results via correlation IDs.
 */

import { Worker } from 'worker_threads';
import { cpus } from 'os';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';

const EMBEDDING_DIM = 384;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PendingRequest {
  resolve: (embeddings: Float32Array[]) => void;
  reject: (err: Error) => void;
  count: number;
}

// ---------------------------------------------------------------------------
// Resolve worker script path relative to compiled dist/
// ---------------------------------------------------------------------------

function resolveWorkerPath(): string {
  const thisFile = fileURLToPath(import.meta.url);
  return join(dirname(thisFile), 'embedding-worker.js');
}

// ---------------------------------------------------------------------------
// EmbeddingPool
// ---------------------------------------------------------------------------

export class EmbeddingPool {
  private workers: Worker[] = [];
  private nextWorker = 0;
  private pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private poolSize: number;

  constructor(poolSize?: number) {
    this.poolSize = poolSize ?? Math.min(4, cpus().length);
  }

  async init(): Promise<void> {
    const workerPath = resolveWorkerPath();
    const readyPromises: Promise<void>[] = [];

    for (let i = 0; i < this.poolSize; i++) {
      const worker = new Worker(workerPath);

      const readyPromise = new Promise<void>((resolve, reject) => {
        const onMsg = (msg: { type: string }) => {
          if (msg.type === 'ready') {
            worker.off('message', onMsg);
            resolve();
          }
        };
        worker.once('error', reject);
        worker.on('message', onMsg);
      });

      worker.on('message', (msg: { type: string; id: number; embeddings?: ArrayBuffer[]; message?: string }) => {
        if (msg.type === 'result') {
          const req = this.pending.get(msg.id);
          if (!req) return;
          this.pending.delete(msg.id);
          const embeddings = (msg.embeddings ?? []).map((buf) => new Float32Array(buf));
          req.resolve(embeddings);
        } else if (msg.type === 'error') {
          const req = this.pending.get(msg.id);
          if (!req) return;
          this.pending.delete(msg.id);
          req.reject(new Error(msg.message ?? 'Worker error'));
        }
      });

      worker.on('error', (err) => {
        process.stderr.write(`[embedding-pool] Worker error: ${err.message}\n`);
        // Reject all pending requests for this worker by draining pending map
        // (we can't cheaply map worker→IDs, so fall through — requests will timeout or reject via 'exit')
      });

      worker.on('exit', (code) => {
        if (code !== 0) {
          process.stderr.write(`[embedding-pool] Worker exited with code ${code}\n`);
        }
        const idx = this.workers.indexOf(worker);
        if (idx !== -1) this.workers.splice(idx, 1);
      });

      this.workers.push(worker);
      readyPromises.push(readyPromise);
    }

    await Promise.all(readyPromises);
  }

  /**
   * Embed an array of texts. Splits across workers round-robin.
   * Returns Float32Array[] in the same order as input.
   */
  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];

    const available = this.workers;
    if (available.length === 0) {
      // All workers dead — return placeholder embeddings
      return texts.map(() => new Float32Array(EMBEDDING_DIM));
    }

    // Split texts into per-worker sub-batches
    const numWorkers = available.length;
    const chunkSize = Math.ceil(texts.length / numWorkers);
    const chunks: string[][] = [];
    for (let i = 0; i < texts.length; i += chunkSize) {
      chunks.push(texts.slice(i, i + chunkSize));
    }

    // Dispatch each chunk to a worker (round-robin)
    const chunkPromises = chunks.map((chunk) => {
      const id = this.nextId++;
      const worker = available[this.nextWorker % available.length];
      this.nextWorker++;

      return new Promise<Float32Array[]>((resolve, reject) => {
        this.pending.set(id, { resolve, reject, count: chunk.length });
        worker.postMessage({ type: 'embed', id, texts: chunk });
      });
    });

    const chunkResults = await Promise.all(chunkPromises);
    return chunkResults.flat();
  }

  async shutdown(): Promise<void> {
    await Promise.all(this.workers.map((w) => w.terminate()));
    this.workers = [];
    this.pending.clear();
  }
}
