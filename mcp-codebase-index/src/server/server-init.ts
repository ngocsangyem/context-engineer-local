/**
 * Shared service initialization for mcp-codebase-index.
 * Used by both stdio (index.ts) and HTTP (express-server.ts) entry points.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { IndexerOrchestrator } from '../indexer/indexer-orchestrator.js';
import { configureEmbeddingPool } from '../indexer/embedding-generator.js';
import { SemanticSearch } from '../retrieval/semantic-search.js';
import { StructuralSearch } from '../retrieval/structural-search.js';
import { HybridRetriever } from '../retrieval/hybrid-retriever.js';
import { GitignoreFilter } from '../utils/gitignore-filter.js';
import { FileWatcherService } from '../watcher/file-watcher-service.js';
import type { TagGraphStore } from '../storage/tag-graph-store.js';
import type { MetadataStore } from '../storage/metadata-store.js';

export interface InitializedServices {
  orchestrator: IndexerOrchestrator;
  retriever: HybridRetriever;
  structural: StructuralSearch;
  tagGraph: TagGraphStore;
  metadataStore: MetadataStore;
  watcher: FileWatcherService | null;
  rootPath: string;
}

// ---------------------------------------------------------------------------
// Data directory utilities (exported for use in entry points)
// ---------------------------------------------------------------------------

/** Derive a stable per-project slug: basename + 6-char hash of normalized full path */
export function projectSlug(rootPath: string): string {
  const normalized = path.resolve(rootPath);
  const base = path.basename(normalized).replace(/[^a-zA-Z0-9_-]/g, '_') || 'root';
  const hash = crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 6);
  return `${base}-${hash}`;
}

/** Resolve the MCP server root by walking up from the compiled entry until package.json is found */
export function findMcpRoot(): string {
  const entryDir = path.dirname(fileURLToPath(import.meta.url));
  let dir = entryDir;
  for (let i = 0; i < 5; i++) {
    try {
      fs.statSync(path.join(dir, 'package.json'));
      return dir;
    } catch {
      dir = path.dirname(dir);
    }
  }
  // Fallback: assume dist/server/ → dist/ → mcp-codebase-index/
  return path.dirname(path.dirname(entryDir));
}

/** Resolve the data directory for a given project inside mcp-codebase-index/data/ */
export function resolveDataDir(rootPath: string): string {
  return path.join(findMcpRoot(), 'data', projectSlug(rootPath));
}

// ---------------------------------------------------------------------------
// Shared CLI argument parsing
// ---------------------------------------------------------------------------

export interface BaseCliArgs {
  rootPath: string;
  watch: boolean;
  excludePatterns: string[];
  poolSize?: number;
}

/** Parse shared CLI flags (--path, --watch, --no-watch, --exclude, --pool-size). Returns extras for caller. */
export function parseBaseArgs(argv: string[]): { base: BaseCliArgs; extras: Map<string, string> } {
  const args = argv.slice(2);
  let rootPath = '';
  let watch = true;
  let poolSize: number | undefined;
  const excludePatterns: string[] = [];
  const extras = new Map<string, string>();

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--path' && args[i + 1]) rootPath = args[++i];
    else if (arg === '--watch') watch = true;
    else if (arg === '--no-watch') watch = false;
    else if (arg === '--exclude' && args[i + 1]) {
      excludePatterns.push(...args[++i].split(',').map((p) => p.trim()).filter(Boolean));
    } else if (arg === '--pool-size' && args[i + 1]) {
      const n = parseInt(args[++i], 10);
      if (!isNaN(n) && n > 0) poolSize = n;
    } else if (arg.startsWith('--') && args[i + 1] && !args[i + 1].startsWith('--')) {
      extras.set(arg, args[++i]);
    }
  }

  return {
    base: { rootPath: rootPath ? path.resolve(rootPath) : '', watch, excludePatterns, poolSize },
    extras,
  };
}

// ---------------------------------------------------------------------------
// Core service initialization
// ---------------------------------------------------------------------------

export interface InitOptions {
  rootPath: string;
  watch: boolean;
  excludePatterns: string[];
  dataDir: string;
  poolSize?: number;
  logFn?: (msg: string) => void;
}

/**
 * Initialize all indexing and retrieval services.
 * Shared between stdio and HTTP entry points.
 */
export async function initializeServices(opts: InitOptions): Promise<InitializedServices> {
  const { rootPath, watch, excludePatterns, dataDir, poolSize, logFn = (m) => process.stderr.write(m + '\n') } = opts;

  // 0. Configure embedding pool size before first use (no-op if already initialized)
  if (poolSize !== undefined) {
    configureEmbeddingPool({ poolSize });
    logFn(`[mcp-codebase-index] Embedding pool size: ${poolSize}`);
  }

  // 1. Gitignore filter
  const gitignoreFilter = new GitignoreFilter(rootPath);

  // 2. Orchestrator owns MetadataStore, LanceVectorStore, TagGraphStore internally
  const orchestrator = new IndexerOrchestrator(rootPath, {
    indexDir: dataDir,
    excludePatterns,
  });

  // 3. Run initial full index
  logFn('[mcp-codebase-index] Running initial index...');
  const stats = await orchestrator.indexAll();
  logFn(
    `[mcp-codebase-index] Index complete — ` +
    `${stats.indexedFiles} files, ${stats.totalChunks} chunks, ` +
    `${stats.vectorCount} vectors, ${stats.graphNodes} graph nodes`
  );

  // 4. Retrieval layer — use the orchestrator's shared internal stores
  const vectorStore = orchestrator.getVectorStore();
  const tagGraph = orchestrator.getTagGraph();
  const metadataStore = orchestrator.getMetadataStore();

  const semantic = new SemanticSearch(vectorStore);
  const structural = new StructuralSearch(tagGraph, rootPath);
  const retriever = new HybridRetriever(semantic, structural, rootPath, metadataStore);

  // Populate structural search symbol cache
  const rankedFiles = tagGraph.getRankedFiles(10000);
  for (const { filePath } of rankedFiles) {
    const definitions = tagGraph.getDefinitions(filePath);
    if (definitions.length > 0) {
      structural.addSymbols(filePath, definitions);
    }
  }

  // 5. Start file watcher if requested
  let watcher: FileWatcherService | null = null;
  if (watch) {
    watcher = new FileWatcherService(rootPath, orchestrator, gitignoreFilter);
    await watcher.start();
  }

  return { orchestrator, retriever, structural, tagGraph, metadataStore, watcher, rootPath };
}
