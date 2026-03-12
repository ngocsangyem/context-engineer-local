/**
 * Orchestrates the full indexing pipeline:
 * scan → hash-check → AST-chunk → embed → batch-store vectors → build graph → batch-store metadata.
 *
 * Supports full re-index, incremental update, and file removal.
 * Uses parallel file processing with a concurrency limit and batch I/O flushes.
 */

import fs from 'fs';
import path from 'path';
import { scanFiles, type ScannedFile } from './file-scanner.js';
import { processFile, type FileProcessOutput } from './indexer-file-processor.js';
import type { SymbolTag } from './ast-chunker.js';
import { LanceVectorStore } from '../storage/lance-vector-store.js';
import { TagGraphStore } from '../storage/tag-graph-store.js';
import { MetadataStore } from '../storage/metadata-store.js';
import { buildGitChangedSet, canSkipByMtime, filterByGitChanges } from './indexer-change-detection-helpers.js';
import { buildIndexPipeline } from './indexing-pipeline.js';

export interface OrchestratorConfig {
  rootPath: string;
  /** Directory where .index/ data is stored (relative to rootPath or absolute) */
  indexDir?: string;
  /** Max file size in bytes (default 1 MB) */
  maxFileSize?: number;
  /** Additional exclude patterns passed to file scanner */
  excludePatterns?: string[];
}

export interface IndexStats {
  totalFiles: number;
  indexedFiles: number;
  skippedFiles: number;
  totalChunks: number;
  vectorCount: number;
  graphNodes: number;
  graphEdges: number;
  /** Timestamp (ms epoch) of the most recently indexed file, or null if empty */
  newestIndexed: number | null;
}

/** Concurrency limit for parallel file processing (conservative — better-sqlite3 is sync). */
const INDEXING_CONCURRENCY = 4;

/**
 * Run async tasks over items with a bounded concurrency limit.
 * Pure JS single-threaded: push() is atomic, no mutex needed.
 */
async function runWithConcurrency<T>(
  items: T[],
  fn: (item: T) => Promise<void>,
  concurrency: number
): Promise<void> {
  let i = 0;
  const next = async (): Promise<void> => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => next()));
}

export class IndexerOrchestrator {
  private readonly rootPath: string;
  private readonly indexDir: string;
  private readonly config: Required<OrchestratorConfig>;

  private vectorStore: LanceVectorStore;
  private tagGraph: TagGraphStore;
  private metadataStore: MetadataStore;

  constructor(rootPath: string, config: Partial<OrchestratorConfig> = {}) {
    this.rootPath = path.resolve(rootPath);
    this.indexDir = config.indexDir
      ? path.resolve(config.indexDir)
      : path.resolve(rootPath, '.index');
    this.config = {
      rootPath: this.rootPath,
      indexDir: this.indexDir,
      maxFileSize: config.maxFileSize ?? 1024 * 1024,
      excludePatterns: config.excludePatterns ?? [],
    };

    fs.mkdirSync(this.indexDir, { recursive: true });

    this.vectorStore = new LanceVectorStore(this.indexDir);
    this.tagGraph = new TagGraphStore();
    this.metadataStore = new MetadataStore(this.indexDir);
  }

  /** Initialize async stores (LanceDB). Must be called before indexing. */
  private async ensureInit(): Promise<void> {
    await this.vectorStore.init();
  }

  /** Flush accumulated file outputs to vector store and metadata store. */
  private async flushBatch(batch: FileProcessOutput[]): Promise<void> {
    if (batch.length === 0) return;

    // Batch vector store upsert
    await this.vectorStore.batchUpsert(
      batch.map((r) => ({ chunks: r.chunks, embeddings: r.embeddings }))
    );

    // Batch SQLite write (single transaction for all files)
    this.metadataStore.batchWriteFileResults(
      batch.map((r) => ({
        filePath: r.filePath,
        hash: r.hash,
        chunkCount: r.chunkCount,
        language: r.language,
        symbols: r.symbols,
        edges: r.edges,
        callEdges: r.callEdges,
      }))
    );
  }

  /**
   * Full index pipeline: scan all files and index any that are new or changed.
   * Removes stale files from index if they no longer exist on disk.
   *
   * @param options.force When true, skips all change detection and re-indexes everything.
   */
  async indexAll(options?: { force?: boolean }): Promise<IndexStats> {
    await this.ensureInit();
    const force = options?.force ?? false;

    this.log('Starting full index scan...');

    const scannedFiles = scanFiles(this.rootPath, {
      maxFileSizeBytes: this.config.maxFileSize,
      extraExcludePatterns: this.config.excludePatterns,
    });

    this.log(`Found ${scannedFiles.length} files to consider.`);

    // Build set of git-changed files for mtime pre-filter (Tier 1 fast path)
    const gitChangedSet = await buildGitChangedSet(this.rootPath, this.metadataStore, this.log.bind(this));

    // Remove stale files (deleted from disk but still in index)
    const currentPaths = scannedFiles.map((f) => f.path);
    const staleFiles = this.metadataStore.getStaleFiles(currentPaths);
    if (staleFiles.length > 0) {
      this.log(`Removing ${staleFiles.length} stale files from index...`);
      await this.removeFiles(staleFiles);
    }

    // Pre-load all last_indexed timestamps in one query (avoids N+1)
    const lastIndexedMap = this.metadataStore.getAllFileLastIndexed();

    // Apply mtime pre-filter before feeding files into the pipeline
    const filesToIndex = force
      ? scannedFiles
      : scannedFiles.filter((file) => {
          if (canSkipByMtime(file.path, gitChangedSet, lastIndexedMap)) return false;
          return true;
        });

    const skippedCount = scannedFiles.length - filesToIndex.length;

    this.log(`Processing ${filesToIndex.length} files via streaming pipeline (${skippedCount} skipped by mtime)...`);

    // 3-stage streaming pipeline: Parse → Embed → Store
    const pipelineResult = await buildIndexPipeline({
      files: filesToIndex,
      metadataStore: this.metadataStore,
      vectorStore: this.vectorStore,
      tagGraph: this.tagGraph,
      rootPath: this.rootPath,
      force,
    });

    const allTags = pipelineResult.tags;
    const indexedCount = pipelineResult.indexedFiles;
    const totalChunks = pipelineResult.totalChunks;

    // Rebuild tag graph from all collected tags, then overlay persisted import edges
    this.log('Building dependency graph...');
    this.tagGraph.buildFromTags(allTags);
    this.tagGraph.loadFromDb(this.metadataStore);

    const vectorCount = await this.vectorStore.count();
    const graphStats = this.tagGraph.getStats();
    const metaStats = this.metadataStore.getStats();

    const stats: IndexStats = {
      totalFiles: scannedFiles.length,
      indexedFiles: indexedCount,
      skippedFiles: skippedCount,
      totalChunks,
      vectorCount,
      graphNodes: graphStats.nodeCount,
      graphEdges: graphStats.edgeCount,
      newestIndexed: metaStats.newestIndexed,
    };

    this.log(
      `Index complete: ${indexedCount} files indexed, ` +
      `${skippedCount} unchanged, ${metaStats.totalChunks} total chunks.`
    );

    return stats;
  }

  /**
   * Incrementally index a specific set of files (e.g. after file-watcher events).
   * If a git repo, uses git change detection to narrow to actually-changed files.
   */
  async indexFiles(filePaths: string[]): Promise<void> {
    await this.ensureInit();

    // Git fast path: filter to only files git considers changed
    const filesToProcess = await filterByGitChanges(this.rootPath, filePaths, this.metadataStore, this.log.bind(this));

    const allTags: SymbolTag[] = [];
    const pendingBatch: FileProcessOutput[] = [];

    await runWithConcurrency(
      filesToProcess,
      async (filePath) => {
        const ext = path.extname(filePath).replace(/^\./, '').toLowerCase();
        const scanned: ScannedFile = {
          path: filePath,
          relativePath: path.relative(this.rootPath, filePath),
          extension: ext,
          language: null,
        };
        const result = await processFile(scanned, this.metadataStore, true);
        if (result) {
          allTags.push(...result.tags);
          pendingBatch.push(result);
        }
      },
      INDEXING_CONCURRENCY
    );

    await this.flushBatch(pendingBatch);
    this.tagGraph.addTags(allTags);
  }

  /**
   * Remove deleted files from the vector store, graph, and metadata.
   * Uses batch operations for efficiency.
   */
  async removeFiles(filePaths: string[]): Promise<void> {
    if (filePaths.length === 0) return;
    await this.ensureInit();

    // Batch delete from vector store
    await this.vectorStore.batchDeleteFiles(filePaths);

    // Remove from tag graph
    for (const fp of filePaths) {
      this.tagGraph.removeFile(fp);
    }

    // Batch delete from SQLite (symbols + edges + call_edges + files in one transaction)
    this.metadataStore.removeFiles(filePaths);
  }

  /** Return current index statistics. */
  async getStats(): Promise<IndexStats> {
    await this.ensureInit();
    const vectorCount = await this.vectorStore.count();
    const graphStats = this.tagGraph.getStats();
    const metaStats = this.metadataStore.getStats();
    return {
      totalFiles: metaStats.fileCount,
      indexedFiles: metaStats.fileCount,
      skippedFiles: 0,
      totalChunks: metaStats.totalChunks,
      vectorCount,
      graphNodes: graphStats.nodeCount,
      graphEdges: graphStats.edgeCount,
      newestIndexed: metaStats.newestIndexed,
    };
  }

  /** Expose the internal TagGraphStore for shared use in retrieval layer. */
  getTagGraph(): TagGraphStore {
    return this.tagGraph;
  }

  /** Expose the internal LanceVectorStore for shared use in retrieval layer. */
  getVectorStore(): LanceVectorStore {
    return this.vectorStore;
  }

  /** Return the resolved data directory path. */
  getIndexDir(): string {
    return this.indexDir;
  }

  /** Expose the MetadataStore for symbol queries. */
  getMetadataStore(): MetadataStore {
    return this.metadataStore;
  }

  private log(msg: string): void {
    process.stderr.write(`[indexer] ${msg}\n`);
  }
}
