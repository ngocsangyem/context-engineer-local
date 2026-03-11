/**
 * Orchestrates the full indexing pipeline:
 * scan → hash-check → AST-chunk → embed → store vectors → build graph → store metadata.
 *
 * Supports full re-index, incremental update, and file removal.
 */

import fs from 'fs';
import path from 'path';
import { scanFiles, type ScannedFile } from './file-scanner.js';
import { processFile } from './indexer-file-processor.js';
import type { SymbolTag } from './ast-chunker.js';
import { LanceVectorStore } from '../storage/lance-vector-store.js';
import { TagGraphStore } from '../storage/tag-graph-store.js';
import { MetadataStore } from '../storage/metadata-store.js';

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

export class IndexerOrchestrator {
  private readonly rootPath: string;
  private readonly indexDir: string;
  private readonly config: Required<OrchestratorConfig>;

  private vectorStore: LanceVectorStore;
  private tagGraph: TagGraphStore;
  private metadataStore: MetadataStore;

  constructor(rootPath: string, config: Partial<OrchestratorConfig> = {}) {
    this.rootPath = path.resolve(rootPath);
    // indexDir: use provided absolute path, or fall back to <rootPath>/.index/
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

  /**
   * Full index pipeline: scan all files and index any that are new or changed.
   * Removes stale files from index if they no longer exist on disk.
   */
  async indexAll(): Promise<IndexStats> {
    await this.ensureInit();
    this.log('Starting full index scan...');

    const scannedFiles = scanFiles(this.rootPath, {
      maxFileSizeBytes: this.config.maxFileSize,
      extraExcludePatterns: this.config.excludePatterns,
    });

    this.log(`Found ${scannedFiles.length} files to consider.`);

    // Remove stale files (deleted from disk but still in index)
    const currentPaths = scannedFiles.map((f) => f.path);
    const staleFiles = this.metadataStore.getStaleFiles(currentPaths);
    if (staleFiles.length > 0) {
      this.log(`Removing ${staleFiles.length} stale files from index...`);
      await this.removeFiles(staleFiles);
    }

    // Index new/changed files
    const allTags: SymbolTag[] = [];
    let indexedCount = 0;
    let skippedCount = 0;
    let totalChunks = 0;

    for (const file of scannedFiles) {
      const result = await processFile(file, this.vectorStore, this.metadataStore);
      if (result === null) {
        skippedCount++;
        continue;
      }
      allTags.push(...result.tags);
      totalChunks += result.chunkCount;
      indexedCount++;

      if (indexedCount % 50 === 0) {
        this.log(`  Indexed ${indexedCount}/${scannedFiles.length} files...`);
      }
    }

    // Rebuild tag graph from all collected tags
    this.log('Building dependency graph...');
    this.tagGraph.buildFromTags(allTags);

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
   */
  async indexFiles(filePaths: string[]): Promise<void> {
    await this.ensureInit();
    const allTags: SymbolTag[] = [];

    for (const filePath of filePaths) {
      const ext = path.extname(filePath).replace(/^\./, '').toLowerCase();
      const scanned: ScannedFile = {
        path: filePath,
        relativePath: path.relative(this.rootPath, filePath),
        extension: ext,
        language: null,
      };
      const result = await processFile(scanned, this.vectorStore, this.metadataStore, true);
      if (result) allTags.push(...result.tags);
    }

    this.tagGraph.addTags(allTags);
  }

  /**
   * Remove deleted files from the vector store, graph, and metadata.
   */
  async removeFiles(filePaths: string[]): Promise<void> {
    await this.ensureInit();
    for (const fp of filePaths) {
      await this.vectorStore.deleteByFile(fp);
      this.tagGraph.removeFile(fp);
    }
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

  private log(msg: string): void {
    process.stderr.write(`[indexer] ${msg}\n`);
  }
}
