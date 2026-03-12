/**
 * MCP server configuration with 6 codebase-indexing tools.
 * Uses stdio transport for Claude Desktop / CLI integration.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { HybridRetriever } from '../retrieval/hybrid-retriever.js';
import type { StructuralSearch } from '../retrieval/structural-search.js';
import type { TagGraphStore } from '../storage/tag-graph-store.js';
import type { IndexerOrchestrator } from '../indexer/indexer-orchestrator.js';
import type { SearchOptions } from '../retrieval/semantic-search.js';
import { formatSearchResults, formatRepoMap } from './mcp-result-formatters.js';
import type { MetadataStore } from '../storage/metadata-store.js';

const execFileAsync = promisify(execFile);

export interface ServerDependencies {
  retriever: HybridRetriever;
  structural: StructuralSearch;
  tagGraph: TagGraphStore;
  orchestrator: IndexerOrchestrator;
  metadataStore: MetadataStore;
  rootPath: string;
}

/**
 * Create and configure the MCP server with all 6 tools.
 * Call .connect(transport) after this to start serving.
 */
export function createServer(deps: ServerDependencies): McpServer {
  const { retriever, structural, tagGraph, orchestrator, metadataStore, rootPath } = deps;

  const server = new McpServer({
    name: 'mcp-codebase-index',
    version: '0.1.0',
  });

  // Tool 1: search_codebase
  server.tool(
    'search_codebase',
    'Hybrid semantic + keyword + structural search across the indexed codebase.',
    {
      query: z.string().describe('Search query'),
      strategy: z
        .enum(['hybrid', 'semantic', 'keyword', 'structural'])
        .default('hybrid')
        .describe('Search strategy'),
      limit: z.number().int().min(1).max(50).default(10).describe('Max results'),
      file_pattern: z.string().optional().describe('Glob pattern to filter files (e.g. "*.ts")'),
    },
    async ({ query, strategy, limit, file_pattern }) => {
      const opts: SearchOptions = { query, strategy, limit, filePattern: file_pattern };
      const results = await retriever.search(opts);
      return { content: [{ type: 'text', text: formatSearchResults(results) }] };
    }
  );

  // Tool 2: get_file_summary
  server.tool(
    'get_file_summary',
    'Get a structural outline (symbols, imports, dependents) for a file.',
    { path: z.string().describe('Absolute or relative path to the file') },
    async ({ path: filePath }) => {
      const summary = await structural.getFileSummary(filePath);
      return { content: [{ type: 'text', text: summary || `No summary available for ${filePath}` }] };
    }
  );

  // Tool 3: get_repo_map
  server.tool(
    'get_repo_map',
    'Get a PageRank-sorted overview of the most important files and their symbols.',
    {
      scope: z.string().optional().describe('Directory prefix to scope the map (e.g. "src/api")'),
      max_tokens: z.number().int().min(256).max(16384).default(2048).describe('Token budget'),
    },
    async ({ scope, max_tokens }) => {
      const entries = await retriever.getRepoMap(scope, max_tokens);
      return { content: [{ type: 'text', text: formatRepoMap(entries) }] };
    }
  );

  // Tool 4: get_recent_changes
  server.tool(
    'get_recent_changes',
    'Get recent git commits and file change statistics.',
    {
      since: z.string().default('7d').describe('Time window e.g. "7d", "24h", "2w"'),
      limit: z.number().int().min(1).max(100).default(20).describe('Max commits'),
    },
    async ({ since, limit }) => {
      try {
        const gitOpts = { cwd: rootPath };
        const [logResult, diffResult] = await Promise.allSettled([
          execFileAsync('git', ['log', '--oneline', `--since=${since}`, `-n`, String(limit)], gitOpts),
          execFileAsync('git', ['diff', '--stat', `HEAD~${Math.min(limit, 10)}`], gitOpts),
        ]);

        const log = logResult.status === 'fulfilled' ? logResult.value.stdout.trim() : 'git log failed';
        const diff = diffResult.status === 'fulfilled' ? diffResult.value.stdout.trim() : '';

        const text = [
          `Recent commits (since ${since}, max ${limit}):`,
          log || '  (no commits found)',
          diff ? `\nChanged files (last ${Math.min(limit, 10)} commits):\n${diff}` : '',
        ].join('\n');

        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err}` }] };
      }
    }
  );

  // Tool 5: get_dependencies
  server.tool(
    'get_dependencies',
    'Get the import graph (dependencies and dependents) for a file.',
    {
      path: z.string().describe('File path to inspect'),
      depth: z.number().int().min(1).max(2).default(1).describe('Dependency depth: 1 = direct imports only, 2 = also shows transitive (depth-2) imports'),
    },
    async ({ path: filePath, depth }) => {
      const deps = tagGraph.getDependencies(filePath);
      const dependents = tagGraph.getDependents(filePath);

      // Load stored edges to show imported symbol names
      const edgeMap = new Map<string, string[]>();
      try {
        const edges = metadataStore.getEdges(filePath);
        for (const e of edges) {
          edgeMap.set(e.toFile, e.symbols);
        }
      } catch {
        // Non-fatal: symbol names are decorative
      }

      const lines: string[] = [`Dependencies for: ${filePath}`, ''];

      if (deps.length > 0) {
        lines.push('Imports (direct):');
        for (const d of deps) {
          const symbols = edgeMap.get(d);
          const symbolSuffix = symbols && symbols.length > 0 && symbols[0] !== '*'
            ? `  { ${symbols.slice(0, 5).join(', ')}${symbols.length > 5 ? ', ...' : ''} }`
            : '';
          lines.push(`  -> ${d}${symbolSuffix}`);
        }
      } else {
        lines.push('Imports: (none found)');
      }

      lines.push('');

      if (dependents.length > 0) {
        lines.push('Imported by:');
        dependents.forEach((d) => lines.push(`  <- ${d}`));
      } else {
        lines.push('Imported by: (none found)');
      }

      // Depth > 1: expand one more level
      if (depth > 1 && deps.length > 0) {
        lines.push('\nTransitive imports (depth 2):');
        for (const dep of deps.slice(0, 10)) {
          const transitive = tagGraph.getDependencies(dep);
          if (transitive.length > 0) {
            lines.push(`  ${dep} imports:`);
            transitive.slice(0, 5).forEach((t) => lines.push(`    -> ${t}`));
          }
        }
      }

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }
  );

  // Tool 6: index_status — enhanced with data path, last-indexed time, staleness
  server.tool(
    'index_status',
    'Get index statistics, data location, last-indexed time, and whether the index exists. Use this to decide if data is fresh or a re-index is needed.',
    {},
    async () => {
      try {
        const STALE_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour
        const stats = await orchestrator.getStats();
        const dataPath = orchestrator.getIndexDir();
        const hasIndex = stats.totalFiles > 0;
        const lastIndexedAt = stats.newestIndexed
          ? new Date(stats.newestIndexed).toISOString()
          : 'never';
        const ageMs = stats.newestIndexed ? Date.now() - stats.newestIndexed : null;
        const stale = ageMs !== null && ageMs > STALE_THRESHOLD_MS;

        const text = [
          'Index Status:',
          `  Has index    : ${hasIndex ? 'yes' : 'no (empty)'}`,
          `  Data path    : ${dataPath}`,
          `  Last indexed : ${lastIndexedAt}`,
          `  Stale (>1h)  : ${stale ? 'yes' : 'no'}`,
          `  Total files  : ${stats.totalFiles}`,
          `  Indexed files: ${stats.indexedFiles}`,
          `  Total chunks : ${stats.totalChunks}`,
          `  Vector count : ${stats.vectorCount}`,
          `  Graph nodes  : ${stats.graphNodes}`,
          `  Graph edges  : ${stats.graphEdges}`,
        ].join('\n');
        return { content: [{ type: 'text', text }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error fetching stats: ${err}` }] };
      }
    }
  );

  // Tool 8: get_call_graph
  server.tool(
    'get_call_graph',
    'Get the call graph for a symbol — who calls it (callers) or what it calls (callees). Uses unresolved call tracking for fast, lightweight results.',
    {
      symbol: z.string().describe('Symbol name to query (e.g. "processFile", "AuthService.login")'),
      direction: z
        .enum(['callers', 'callees'])
        .default('callers')
        .describe('"callers" = who calls this symbol; "callees" = what this symbol calls'),
      file: z.string().optional().describe('Scope callees query to a specific file path'),
      limit: z.number().int().min(1).max(100).default(30).describe('Max results'),
    },
    async ({ symbol, direction, file, limit }) => {
      try {
        const lines: string[] = [];

        if (direction === 'callers') {
          const callers = metadataStore.getCallers(symbol, limit);
          if (callers.length === 0) {
            return { content: [{ type: 'text', text: `No recorded callers for "${symbol}".` }] };
          }
          lines.push(`Callers of "${symbol}" (${callers.length} found):`);
          lines.push('');
          for (const e of callers) {
            lines.push(`  ${e.callerSymbol}`);
            lines.push(`    in: ${e.callerFile}:${e.callerLine}`);
          }
        } else {
          // callees
          const targetFile = file ?? '';
          if (!targetFile) {
            return {
              content: [{
                type: 'text',
                text: 'For direction="callees", provide a "file" parameter to scope the query.',
              }],
            };
          }
          const callees = metadataStore.getCallees(targetFile, symbol, limit);
          if (callees.length === 0) {
            return {
              content: [{
                type: 'text',
                text: `No recorded callees for "${symbol}" in ${targetFile}.`,
              }],
            };
          }
          lines.push(`Callees of "${symbol}" in ${targetFile} (${callees.length} found):`);
          lines.push('');
          for (const e of callees) {
            lines.push(`  -> ${e.calleeName}  (line ${e.callerLine})`);
          }
        }

        return { content: [{ type: 'text', text: lines.join('\n') }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error querying call graph: ${err}` }] };
      }
    }
  );

  // Tool 7: search_symbols
  server.tool(
    'search_symbols',
    'Search the symbol index for functions, classes, methods, types by name. Returns signatures, parameters, and locations.',
    {
      query: z.string().describe('Symbol name to search (prefix match)'),
      kind: z
        .enum(['function', 'class', 'method', 'type', 'interface', 'variable', 'enum'])
        .optional()
        .describe('Filter by symbol kind'),
      limit: z.number().int().min(1).max(50).default(20).describe('Max results'),
    },
    async ({ query, kind, limit }) => {
      const symbols = metadataStore.searchSymbols(query, kind, limit);
      if (symbols.length === 0) {
        return { content: [{ type: 'text', text: `No symbols matching "${query}" found.` }] };
      }

      const lines = symbols.map((s, i) => {
        const parts = [
          `[${i + 1}] ${s.visibility === 'exported' ? 'export ' : ''}${s.kind} ${s.qualifiedName}`,
          `    file: ${s.filePath}:${s.startLine}-${s.endLine}`,
          `    signature: ${s.signature}`,
        ];
        if (s.parameters?.length) {
          parts.push(`    params: ${s.parameters.map(p => p.type ? `${p.name}: ${p.type}` : p.name).join(', ')}`);
        }
        if (s.returnType) {
          parts.push(`    returns: ${s.returnType}`);
        }
        return parts.join('\n');
      });

      return { content: [{ type: 'text', text: lines.join('\n\n') }] };
    }
  );

  return server;
}
