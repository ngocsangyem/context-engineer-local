/**
 * MCP prompt registrations for guided codebase exploration.
 * Each prompt provides a structured workflow using available tools.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

export function registerPrompts(server: McpServer): void {

  server.prompt(
    'explore-codebase',
    'Guided exploration of an unfamiliar codebase — overview, key files, architecture',
    { focus: z.string().optional().describe('Optional area to focus on (e.g. "auth", "api")') },
    async ({ focus }) => ({
      messages: [{
        role: 'user' as const,
        content: {
          type: 'text' as const,
          text: [
            'I want to understand this codebase. Please:',
            '1. Run `index_status` to check indexing state',
            `2. Run \`get_repo_map\`${focus ? ` with scope "${focus}"` : ''} to see key files`,
            '3. For the top 3 most important files, run `get_file_summary`',
            '4. Run `get_dependencies` on the main entry point',
            '5. Synthesize: what does this codebase do, key modules, how they connect?',
          ].join('\n'),
        },
      }],
    })
  );

  server.prompt(
    'find-implementation',
    'Locate where a feature or concept is implemented in the codebase',
    { feature: z.string().describe('Feature or concept to find') },
    async ({ feature }) => ({
      messages: [{
        role: 'user' as const,
        content: {
          type: 'text' as const,
          text: [
            `Find where "${feature}" is implemented:`,
            `1. Run \`search_codebase\` with query "${feature}" using strategy "hybrid"`,
            `2. Run \`search_symbols\` with query "${feature}"`,
            '3. For the top 3 results, run `get_file_summary`',
            '4. Run `get_dependencies` on the most relevant file',
            '5. Run `get_call_graph` on key symbols to trace execution flow',
            `6. Summarize: where is "${feature}" implemented, key files and entry points?`,
          ].join('\n'),
        },
      }],
    })
  );

  server.prompt(
    'analyze-dependencies',
    'Deep dependency analysis — imports, dependents, call graph for a file',
    { file_path: z.string().describe('File path to analyze') },
    async ({ file_path }) => ({
      messages: [{
        role: 'user' as const,
        content: {
          type: 'text' as const,
          text: [
            `Analyze dependencies for "${file_path}":`,
            `1. Run \`get_dependencies\` with path "${file_path}" and depth 2`,
            `2. Run \`get_file_summary\` for "${file_path}"`,
            '3. For each direct import, run `get_file_summary`',
            `4. Run \`get_call_graph\` for key exported symbols with direction "callers"`,
            '5. Summarize: dependency tree, coupling, circular deps, refactoring suggestions',
          ].join('\n'),
        },
      }],
    })
  );

  server.prompt(
    'review-changes',
    'Review recent code changes with full context — commits, changed files, impact',
    { since: z.string().default('7d').describe('Time window (e.g. "7d", "24h", "2w")') },
    async ({ since }) => ({
      messages: [{
        role: 'user' as const,
        content: {
          type: 'text' as const,
          text: [
            `Review recent changes (since ${since}):`,
            `1. Run \`get_recent_changes\` with since "${since}"`,
            '2. For each frequently changed file, run `get_file_summary`',
            '3. Run `get_dependencies` on changed files to assess blast radius',
            '4. Identify patterns: concentrated changes? Risky cross-cutting changes?',
            '5. Summarize: what changed, impact assessment, concerns or suggestions',
          ].join('\n'),
        },
      }],
    })
  );
}
