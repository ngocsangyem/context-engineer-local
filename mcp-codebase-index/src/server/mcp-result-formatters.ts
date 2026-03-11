/**
 * Text formatting helpers for MCP tool responses.
 * Converts search/retrieval result objects into human-readable strings.
 */

import type { SearchResult, RepoMapEntry } from '../retrieval/semantic-search.js';

/** Format an array of search results as numbered, readable text. */
export function formatSearchResults(results: SearchResult[]): string {
  if (results.length === 0) return 'No results found.';
  return results
    .map((r, i) => {
      const header =
        `[${i + 1}] ${r.filePath} (lines ${r.startLine}-${r.endLine}, ` +
        `score: ${r.score.toFixed(2)}, source: ${r.source})`;
      const snippet = r.content.slice(0, 300).replace(/\n/g, '\n    ');
      return `${header}\n    ${snippet}`;
    })
    .join('\n\n');
}

/** Format an array of repo-map entries as ranked file list with symbols. */
export function formatRepoMap(entries: RepoMapEntry[]): string {
  if (entries.length === 0) return 'No entries in repo map.';
  return entries
    .map((e) => {
      const syms = e.symbols.length > 0 ? `\n  symbols: ${e.symbols.join(', ')}` : '';
      const deps = e.dependencies.length > 0 ? `\n  imports: ${e.dependencies.join(', ')}` : '';
      return `${e.filePath} (rank: ${e.rank.toFixed(4)})${syms}${deps}`;
    })
    .join('\n');
}
