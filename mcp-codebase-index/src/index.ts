#!/usr/bin/env node
// Suppress LanceDB/DataFusion Rust debug/trace logs before any native module loads
if (!process.env.RUST_LOG) process.env.RUST_LOG = 'off';

/**
 * Stdio entry point for mcp-codebase-index MCP server.
 * Parses CLI args, initializes all components, runs initial indexing,
 * starts the MCP server on stdio, and optionally watches for file changes.
 *
 * Usage: mcp-codebase-index --path <dir> [--watch] [--exclude <patterns>]
 *
 * IMPORTANT: stdout is reserved for MCP JSON-RPC. All logs go to stderr.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server/mcp-server-setup.js';
import { initializeServices, resolveDataDir, parseBaseArgs } from './server/server-init.js';
import { shutdownEmbeddingPool } from './indexer/embedding-generator.js';

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { base } = parseBaseArgs(process.argv);
  if (!base.rootPath) {
    process.stderr.write('Usage: mcp-codebase-index --path <directory> [--no-watch] [--exclude <patterns>] [--pool-size N]\n');
    process.exit(1);
  }
  const { rootPath, watch, excludePatterns, poolSize } = base;
  const dataDir = resolveDataDir(rootPath);

  process.stderr.write(`[mcp-codebase-index] Starting — root: ${rootPath}\n`);
  process.stderr.write(`[mcp-codebase-index] Data dir: ${dataDir}\n`);
  process.stderr.write(`[mcp-codebase-index] Watch mode: ${watch}\n`);

  const services = await initializeServices({
    rootPath,
    watch,
    excludePatterns,
    dataDir,
    poolSize,
    logFn: (msg) => process.stderr.write(msg + '\n'),
  });

  // Create and connect MCP server via stdio
  const server = createServer({
    retriever: services.retriever,
    structural: services.structural,
    tagGraph: services.tagGraph,
    orchestrator: services.orchestrator,
    metadataStore: services.metadataStore,
    rootPath: services.rootPath,
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.stderr.write('[mcp-codebase-index] MCP server ready on stdio.\n');

  // Graceful shutdown
  const shutdown = async (signal: string): Promise<void> => {
    process.stderr.write(`[mcp-codebase-index] Received ${signal}, shutting down...\n`);
    if (services.watcher) await services.watcher.stop();
    await shutdownEmbeddingPool();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  process.stderr.write(`[mcp-codebase-index] Fatal: ${err}\n`);
  process.exit(1);
});
