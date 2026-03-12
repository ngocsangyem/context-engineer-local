/**
 * MCP resource registrations for codebase index data.
 * Exposes indexed files, stats, symbols as browseable resources.
 */

import path from 'path';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ServerDependencies } from './mcp-server-setup.js';

export function registerResources(server: McpServer, deps: ServerDependencies): void {
  const { orchestrator, metadataStore, tagGraph, rootPath } = deps;

  // Resource 1: Index statistics
  server.resource(
    'index-stats',
    'codebase://stats',
    { description: 'Current index statistics (file count, chunks, vectors, graph)' },
    async (uri) => ({
      contents: [{
        uri: uri.href,
        mimeType: 'application/json',
        text: JSON.stringify(await orchestrator.getStats(), null, 2),
      }],
    })
  );

  // Resource 2: All indexed files
  server.resource(
    'file-list',
    'codebase://files',
    { description: 'List of all indexed files with language and chunk count' },
    async (uri) => ({
      contents: [{
        uri: uri.href,
        mimeType: 'application/json',
        text: JSON.stringify(
          metadataStore.getAllFiles().map((f) => ({
            path: f.path,
            language: f.language,
            chunks: f.chunkCount,
          }))
        ),
      }],
    })
  );

  // Resource 3: File detail (URI template)
  server.resource(
    'file-detail',
    new ResourceTemplate('codebase://file/{path}', { list: undefined }),
    { description: 'Symbols and dependencies for a specific file' },
    async (uri, params) => {
      const filePath = Array.isArray(params.path) ? params.path[0] : params.path as string;
      // Validate path stays within indexed root (prevent traversal)
      const resolved = path.resolve(rootPath, filePath);
      if (!resolved.startsWith(rootPath)) {
        return { contents: [{ uri: uri.href, mimeType: 'application/json', text: '{"error":"path outside root"}' }] };
      }
      const symbols = metadataStore.getFileSymbols(filePath);
      const imports = tagGraph.getDependencies(filePath);
      const dependents = tagGraph.getDependents(filePath);
      return {
        contents: [{
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify({ filePath, symbols, imports, dependents }, null, 2),
        }],
      };
    }
  );

  // Resource 4: Symbols by kind (URI template)
  server.resource(
    'symbols-by-kind',
    new ResourceTemplate('codebase://symbols/{kind}', { list: undefined }),
    { description: 'All symbols of a given kind (function, class, method, etc.)' },
    async (uri, params) => {
      const kind = Array.isArray(params.kind) ? params.kind[0] : params.kind as string;
      const symbols = metadataStore.searchSymbols('', kind, 200);
      return {
        contents: [{
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(symbols, null, 2),
        }],
      };
    }
  );
}
