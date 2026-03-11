#!/usr/bin/env node
/**
 * Entry point for mcp-codebase-index MCP server.
 * Parses CLI args, initializes all components, runs initial indexing,
 * starts the MCP server on stdio, and optionally watches for file changes.
 *
 * Usage: mcp-codebase-index --path <dir> [--watch] [--exclude <patterns>]
 *
 * IMPORTANT: stdout is reserved for MCP JSON-RPC. All logs go to stderr.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { IndexerOrchestrator } from './indexer/indexer-orchestrator.js';
import { SemanticSearch } from './retrieval/semantic-search.js';
import { StructuralSearch } from './retrieval/structural-search.js';
import { HybridRetriever } from './retrieval/hybrid-retriever.js';
import { GitignoreFilter } from './utils/gitignore-filter.js';
import { FileWatcherService } from './watcher/file-watcher-service.js';
import { createServer } from './server/mcp-server-setup.js';

// ---------------------------------------------------------------------------
// Data directory resolution — stores index data in mcp-codebase-index/data/
// ---------------------------------------------------------------------------

/** Derive a stable per-project slug: basename + 6-char hash of normalized full path */
function projectSlug(rootPath: string): string {
  const normalized = path.resolve(rootPath);
  const base = path.basename(normalized).replace(/[^a-zA-Z0-9_-]/g, '_') || 'root';
  const hash = crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 6);
  return `${base}-${hash}`;
}

/** Resolve the MCP server root by walking up from the compiled entry until package.json is found */
function findMcpRoot(): string {
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
  // Fallback: assume dist/ → mcp-codebase-index/
  return path.dirname(entryDir);
}

/** Resolve the data directory for a given project inside mcp-codebase-index/data/ */
function resolveDataDir(rootPath: string): string {
  return path.join(findMcpRoot(), 'data', projectSlug(rootPath));
}

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

interface CliArgs {
  rootPath: string;
  watch: boolean;
  excludePatterns: string[];
}

function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);
  let rootPath = '';
  let watch = true;
  const excludePatterns: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--path' && args[i + 1]) {
      rootPath = args[++i];
    } else if (arg === '--watch') {
      watch = true;
    } else if (arg === '--no-watch') {
      watch = false;
    } else if (arg === '--exclude' && args[i + 1]) {
      excludePatterns.push(...args[++i].split(',').map((p) => p.trim()).filter(Boolean));
    }
  }

  if (!rootPath) {
    process.stderr.write('Usage: mcp-codebase-index --path <directory> [--no-watch] [--exclude <patterns>]\n');
    process.exit(1);
  }

  return { rootPath: path.resolve(rootPath), watch, excludePatterns };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { rootPath, watch, excludePatterns } = parseArgs(process.argv);

  // Compute data directory inside mcp-codebase-index/data/<project-slug>/
  const dataDir = resolveDataDir(rootPath);

  process.stderr.write(`[mcp-codebase-index] Starting — root: ${rootPath}\n`);
  process.stderr.write(`[mcp-codebase-index] Data dir: ${dataDir}\n`);
  process.stderr.write(`[mcp-codebase-index] Watch mode: ${watch}\n`);

  // 1. Gitignore filter (used by watcher to skip ignored files)
  const gitignoreFilter = new GitignoreFilter(rootPath);

  // 2. Orchestrator owns MetadataStore, LanceVectorStore, TagGraphStore internally
  //    indexDir points to mcp-codebase-index/data/<slug>/ (persists across restarts)
  const orchestrator = new IndexerOrchestrator(rootPath, {
    indexDir: dataDir,
    excludePatterns,
  });

  // 3. Run initial full index before building retrieval layer so stores are populated
  process.stderr.write('[mcp-codebase-index] Running initial index...\n');
  const stats = await orchestrator.indexAll();
  process.stderr.write(
    `[mcp-codebase-index] Index complete — ` +
    `${stats.indexedFiles} files, ${stats.totalChunks} chunks, ` +
    `${stats.vectorCount} vectors, ${stats.graphNodes} graph nodes\n`
  );

  // 4. Retrieval layer — use the orchestrator's shared internal stores (fixes dual-instance bugs)
  const vectorStore = orchestrator.getVectorStore();
  const tagGraph = orchestrator.getTagGraph();

  const semantic = new SemanticSearch(vectorStore);
  const structural = new StructuralSearch(tagGraph, rootPath);
  const retriever = new HybridRetriever(semantic, structural, rootPath);

  // Populate structural search symbol cache from the built tag graph definition names
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

  // 6. Create and connect MCP server
  const server = createServer({ retriever, structural, tagGraph, orchestrator, rootPath });
  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.stderr.write('[mcp-codebase-index] MCP server ready on stdio.\n');

  // 7. Graceful shutdown
  const shutdown = async (signal: string): Promise<void> => {
    process.stderr.write(`[mcp-codebase-index] Received ${signal}, shutting down...\n`);
    if (watcher) await watcher.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  process.stderr.write(`[mcp-codebase-index] Fatal: ${err}\n`);
  process.exit(1);
});
