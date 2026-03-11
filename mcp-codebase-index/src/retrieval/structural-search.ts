/**
 * Structural search using PageRank-ranked dependency graph.
 * Builds repo maps and file outlines from tag graph data.
 * Ranks files by graph importance and query-term relevance.
 */

import path from 'path';
import type { TagGraphStore } from '../storage/tag-graph-store.js';
import { countTokens } from '../utils/token-counter.js';
import type { SearchResult, RepoMapEntry } from './semantic-search.js';

/** Internal structure storing per-file symbol info */
interface FileSymbolInfo {
  filePath: string;
  rank: number;
  definitions: string[];
}

export class StructuralSearch {
  /** Cache of definition symbols per file, populated via addSymbols */
  private readonly fileSymbols: Map<string, string[]> = new Map();

  constructor(
    private readonly graph: TagGraphStore,
    private readonly rootPath: string
  ) {}

  /**
   * Register definition symbols for a file.
   * Call this after indexing to populate structural search data.
   */
  addSymbols(filePath: string, definitions: string[]): void {
    this.fileSymbols.set(filePath, definitions);
  }

  /**
   * Search files by PageRank rank, boosting files whose path or symbols
   * contain query keywords.
   */
  async search(query: string, limit: number): Promise<SearchResult[]> {
    const queryTerms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const ranked = this.graph.getRankedFiles(limit * 3);

    const scored: FileSymbolInfo[] = ranked.map(({ filePath, score }) => {
      const symbols = this.fileSymbols.get(filePath) ?? [];
      const pathLower = filePath.toLowerCase();
      const symbolText = symbols.join(' ').toLowerCase();

      // Boost score when query terms appear in path or symbol names
      let boost = 0;
      for (const term of queryTerms) {
        if (pathLower.includes(term)) boost += 0.3;
        if (symbolText.includes(term)) boost += 0.2;
      }

      return { filePath, rank: score + boost, definitions: symbols };
    });

    scored.sort((a, b) => b.rank - a.rank);

    const maxRank = Math.max(...scored.map((s) => s.rank), 1);

    return scored.slice(0, limit).map((s) => ({
      filePath: s.filePath,
      content: this.buildOutline(s.filePath, s.definitions),
      score: s.rank / maxRank,
      startLine: 1,
      endLine: 1,
      chunkName: path.basename(s.filePath),
      chunkType: 'module',
      source: 'structural' as const,
    }));
  }

  /**
   * Build a repo map sorted by PageRank, optionally scoped to a directory.
   * Packs entries until the maxTokens budget is exhausted.
   */
  async buildRepoMap(scope?: string, maxTokens = 4000): Promise<RepoMapEntry[]> {
    const ranked = this.graph.getRankedFiles(200);
    const entries: RepoMapEntry[] = [];
    let tokenBudget = maxTokens;

    for (const { filePath, score } of ranked) {
      if (scope && !filePath.startsWith(scope)) continue;

      const symbols = this.fileSymbols.get(filePath) ?? [];
      const deps = this.graph.getDependencies(filePath);
      const dependents = this.graph.getDependents(filePath);

      const entry: RepoMapEntry = {
        filePath,
        rank: score,
        symbols,
        dependencies: deps,
        dependents,
      };

      // Estimate tokens for this entry
      const entryText = `${filePath} ${symbols.join(' ')}`;
      const tokens = countTokens(entryText);
      if (tokens > tokenBudget) break;
      tokenBudget -= tokens;

      entries.push(entry);
    }

    return entries;
  }

  /**
   * Build a human-readable outline for a single file.
   * Format: "// filePath\n- symbol1\n- symbol2\n..."
   */
  async getFileSummary(filePath: string): Promise<string> {
    const symbols = this.fileSymbols.get(filePath) ?? [];
    const deps = this.graph.getDependencies(filePath);
    const dependents = this.graph.getDependents(filePath);

    const lines: string[] = [`// ${filePath}`];
    if (deps.length > 0) lines.push(`imports: ${deps.map((p) => path.basename(p)).join(', ')}`);
    if (dependents.length > 0) lines.push(`used by: ${dependents.map((p) => path.basename(p)).join(', ')}`);
    for (const sym of symbols) lines.push(`- ${sym}`);

    return lines.join('\n');
  }

  /** Build a short outline string from symbol definitions. */
  private buildOutline(filePath: string, definitions: string[]): string {
    const lines = [`// ${filePath}`];
    for (const sym of definitions) lines.push(`- ${sym}`);
    return lines.join('\n');
  }
}
