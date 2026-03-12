#!/usr/bin/env node
// Suppress LanceDB/DataFusion Rust debug/trace logs before any native module loads
if (!process.env.RUST_LOG) process.env.RUST_LOG = 'off';

/**
 * HTTP entry point for mcp-codebase-index MCP server.
 * Starts Express with StreamableHTTPServerTransport for web-based MCP clients.
 *
 * Usage: express-server --path <dir> [--port 3847] [--no-watch] [--exclude <patterns>]
 */

import { randomUUID } from 'crypto';
import express from 'express';
import cors from 'cors';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createDeferredServer } from './server/mcp-server-setup.js';
import { initializeServices, resolveDataDir, parseBaseArgs } from './server/server-init.js';
import { shutdownEmbeddingPool } from './indexer/embedding-generator.js';

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { base, extras } = parseBaseArgs(process.argv);
  if (!base.rootPath) {
    console.error('Usage: express-server --path <directory> [--port 3847] [--no-watch] [--exclude <patterns>]');
    process.exit(1);
  }
  const { rootPath, watch, excludePatterns, poolSize } = base;

  // Parse HTTP-specific --port flag
  let port = 3847;
  if (extras.has('--port')) {
    const parsed = parseInt(extras.get('--port')!, 10);
    if (isNaN(parsed) || parsed < 1 || parsed > 65535) {
      console.error(`Invalid port: ${extras.get('--port')}. Must be 1-65535.`);
      process.exit(1);
    }
    port = parsed;
  }
  const dataDir = resolveDataDir(rootPath);

  console.log(`[mcp-codebase-index] Starting HTTP server — root: ${rootPath}`);
  console.log(`[mcp-codebase-index] Data dir: ${dataDir}`);
  console.log(`[mcp-codebase-index] Watch mode: ${watch}`);

  // Start indexing in background — HTTP server starts immediately
  let servicesReady = false;
  const servicesPromise = initializeServices({ rootPath, watch, excludePatterns, dataDir, poolSize })
    .then((s) => { servicesReady = true; return s; });

  const app = express();
  // Restrict CORS to localhost origins (local development tool)
  app.use(cors({
    origin: [
      'http://localhost', /^http:\/\/localhost:\d+$/,
      'http://127.0.0.1', /^http:\/\/127\.0\.0\.1:\d+$/,
    ],
  }));
  app.use(express.json());

  // Session-based transport management with activity tracking
  interface SessionRecord {
    transport: StreamableHTTPServerTransport;
    lastActivity: number;
  }
  const sessions = new Map<string, SessionRecord>();

  // POST /mcp — new or resumed session
  app.post('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (sessionId && sessions.has(sessionId)) {
      const record = sessions.get(sessionId)!;
      record.lastActivity = Date.now();
      await record.transport.handleRequest(req, res);
      return;
    }

    // New session — server initializes immediately, tools await indexing lazily
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });

    const server = createDeferredServer(servicesPromise);

    await server.connect(transport);

    // Store session after connection (sessionId is assigned during connect)
    const newSessionId = (transport as unknown as { sessionId?: string }).sessionId;
    if (newSessionId) {
      sessions.set(newSessionId, { transport, lastActivity: Date.now() });
      transport.onclose = () => sessions.delete(newSessionId);
    }

    await transport.handleRequest(req, res);
  });

  // GET /mcp — SSE stream for existing session
  app.get('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    const record = sessionId ? sessions.get(sessionId) : undefined;
    if (!record) {
      res.status(400).json({ error: 'No active session. Send POST /mcp first.' });
      return;
    }
    record.lastActivity = Date.now();
    await record.transport.handleRequest(req, res);
  });

  // DELETE /mcp — close session
  app.delete('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    const record = sessionId ? sessions.get(sessionId) : undefined;
    if (record) {
      await record.transport.close();
      sessions.delete(sessionId!);
    }
    res.status(200).json({ status: 'closed' });
  });

  // GET /health — liveness check with indexing status
  app.get('/health', (_req, res) => {
    res.json({
      status: servicesReady ? 'ready' : 'indexing',
      sessions: sessions.size,
      uptime: process.uptime(),
      rootPath,
    });
  });

  // Reap idle sessions every minute (30min idle timeout, max 100 concurrent)
  const MAX_SESSIONS = 100;
  const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
  setInterval(() => {
    const now = Date.now();
    let removed = 0;
    for (const [id, record] of sessions) {
      const idle = now - record.lastActivity > IDLE_TIMEOUT_MS;
      const overLimit = sessions.size - removed > MAX_SESSIONS;
      if (idle || overLimit) {
        record.transport.close().catch(() => {});
        sessions.delete(id);
        removed++;
      }
    }
    if (removed > 0) {
      console.log(`[mcp-codebase-index] Reaped ${removed} idle sessions`);
    }
  }, 60 * 1000).unref();

  app.listen(port, '0.0.0.0', () => {
    console.log(`[mcp-codebase-index] HTTP server ready on port ${port}`);
    console.log(`[mcp-codebase-index] MCP endpoint: http://127.0.0.1:${port}/mcp`);
    console.log(`[mcp-codebase-index] Health check: http://127.0.0.1:${port}/health`);
  });

  // Graceful shutdown
  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[mcp-codebase-index] Received ${signal}, shutting down...`);
    for (const [id, record] of sessions) {
      await record.transport.close();
      sessions.delete(id);
    }
    if (servicesReady) {
      const services = await servicesPromise;
      if (services.watcher) await services.watcher.stop();
    }
    await shutdownEmbeddingPool();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error(`[mcp-codebase-index] Fatal: ${err}`);
  process.exit(1);
});
