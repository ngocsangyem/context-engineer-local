/**
 * Hybrid retriever orchestrating semantic, keyword, structural, and symbol search.
 * Dispatches queries to one or all strategies, then merges via ResultRanker.
 * Optionally expands results with call-graph context via ContextExpander.
 */

import type { SemanticSearch } from './semantic-search.js';
import type { StructuralSearch } from './structural-search.js';
import type { MetadataStore } from '../storage/metadata-store.js';
import { keywordSearch } from './keyword-search.js';
import { rankAndMerge } from './result-ranker.js';
import { searchBySymbol } from './symbol-search.js';
import { expandContext } from './context-expander.js';
import type { SearchResult, SearchOptions, RepoMapEntry } from './semantic-search.js';

const DEFAULT_LIMIT = 10;

export class HybridRetriever {
  constructor(
    private readonly semantic: SemanticSearch,
    private readonly structural: StructuralSearch,
    private readonly rootPath: string,
    private readonly metadataStore?: MetadataStore
  ) {}

  /**
   * Run search using the specified strategy (default: hybrid).
   * - hybrid: runs semantic + keyword + structural + symbol in parallel, merges via weighted score fusion
   * - symbol: direct symbol-table lookup (high precision, exact/prefix match)
   * - semantic/keyword/structural: single-strategy pass-through
   *
   * If options.expand=true, top results are enriched with call-graph context.
   */
  async search(options: SearchOptions): Promise<SearchResult[]> {
    const { query, strategy = 'hybrid', filePattern, expand } = options;
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

        case 'symbol': {
          if (!this.metadataStore) {
            process.stderr.write('HybridRetriever: symbol strategy requires metadataStore\n');
            merged = [];
          } else {
            merged = searchBySymbol(query, this.metadataStore, limit);
          }
          break;
        }

        case 'hybrid':
        default: {
          const parallelTasks: Promise<SearchResult[]>[] = [
            this.semantic.search(query, limit, filePattern),
            keywordSearch(query, this.rootPath, limit, filePattern),
            this.structural.search(query, limit),
          ];

          // Include symbol search when metadataStore is available
          if (this.metadataStore) {
            parallelTasks.push(
              Promise.resolve(searchBySymbol(query, this.metadataStore, limit))
            );
          }

          const allResults = await Promise.all(parallelTasks);
          merged = rankAndMerge(allResults.flat());
          break;
        }
      }

      const sliced = merged.slice(0, limit);

      // Optional context expansion via call graph
      if (expand && this.metadataStore) {
        return expandContext(sliced, this.metadataStore);
      }

      return sliced;
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
