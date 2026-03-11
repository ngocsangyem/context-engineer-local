/**
 * Hybrid retriever orchestrating semantic, keyword, and structural search.
 * Dispatches queries to one or all strategies, then merges via ResultRanker.
 */

import type { SemanticSearch } from './semantic-search.js';
import type { StructuralSearch } from './structural-search.js';
import { keywordSearch } from './keyword-search.js';
import { rankAndMerge } from './result-ranker.js';
import type { SearchResult, SearchOptions, RepoMapEntry } from './semantic-search.js';

const DEFAULT_LIMIT = 10;

export class HybridRetriever {
  constructor(
    private readonly semantic: SemanticSearch,
    private readonly structural: StructuralSearch,
    private readonly rootPath: string
  ) {}

  /**
   * Run search using the specified strategy (default: hybrid).
   * Hybrid runs all three in parallel and merges via weighted score fusion.
   */
  async search(options: SearchOptions): Promise<SearchResult[]> {
    const { query, strategy = 'hybrid', filePattern } = options;
    const limit = options.limit ?? DEFAULT_LIMIT;

    try {
      let merged: SearchResult[];

      switch (strategy) {
        case 'semantic':
          merged = await this.semantic.search(query, limit, filePattern);
          break;

        case 'keyword':
          merged = await keywordSearch(query, this.rootPath, limit, filePattern);
          break;

        case 'structural':
          merged = await this.structural.search(query, limit);
          break;

        case 'hybrid':
        default: {
          const [semResults, kwResults, structResults] = await Promise.all([
            this.semantic.search(query, limit, filePattern),
            keywordSearch(query, this.rootPath, limit, filePattern),
            this.structural.search(query, limit),
          ]);
          merged = rankAndMerge([...semResults, ...kwResults, ...structResults]);
          break;
        }
      }

      return merged.slice(0, limit);
    } catch (err) {
      process.stderr.write(`HybridRetriever.search error: ${err}\n`);
      return [];
    }
  }

  /**
   * Build a repo map sorted by PageRank importance.
   * Delegates to StructuralSearch.
   */
  async getRepoMap(scope?: string, maxTokens?: number): Promise<RepoMapEntry[]> {
    return this.structural.buildRepoMap(scope, maxTokens);
  }

  /**
   * Get a human-readable outline for a single file.
   * Delegates to StructuralSearch.
   */
  async getFileSummary(filePath: string): Promise<string> {
    return this.structural.getFileSummary(filePath);
  }
}
