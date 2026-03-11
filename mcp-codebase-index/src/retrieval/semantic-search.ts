/**
 * Semantic search using LanceDB vector similarity.
 * Generates an embedding for the query, searches the vector store,
 * and returns normalized SearchResult objects.
 */

import path from 'path';
import type { LanceVectorStore } from '../storage/lance-vector-store.js';
import { embedText } from '../indexer/embedding-generator.js';

/**
 * Minimal glob matcher: supports * (any chars except /) and ** (any chars).
 * Matches against the full path or just the basename when pattern has no slash.
 */
function globMatch(filePath: string, pattern: string): boolean {
  const testPath = pattern.includes('/') ? filePath : path.basename(filePath);
  const regex = new RegExp(
    '^' +
    pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '.+')
      .replace(/\*/g, '[^/]*') +
    '$'
  );
  return regex.test(testPath);
}

export interface SearchResult {
  filePath: string;
  content: string;
  /** Normalized relevance score 0–1, higher = more relevant */
  score: number;
  startLine: number;
  endLine: number;
  chunkName?: string;
  chunkType?: string;
  language?: string;
  source: 'semantic' | 'keyword' | 'structural';
}

export interface SearchOptions {
  query: string;
  strategy?: 'hybrid' | 'semantic' | 'keyword' | 'structural';
  /** Maximum results to return. Default: 10 */
  limit?: number;
  /** Glob pattern to filter by file path e.g. "*.ts" */
  filePattern?: string;
}

export interface RepoMapEntry {
  filePath: string;
  /** PageRank score */
  rank: number;
  /** Key function/class names */
  symbols: string[];
  /** Files this imports */
  dependencies: string[];
  /** Files that import this */
  dependents: string[];
}

export class SemanticSearch {
  constructor(private readonly store: LanceVectorStore) {}

  /**
   * Search for code chunks semantically similar to the query.
   * Over-fetches by 2x to allow for file pattern filtering.
   */
  async search(
    query: string,
    limit: number,
    filePattern?: string
  ): Promise<SearchResult[]> {
    try {
      const queryVector = await embedText(query);
      const fetchLimit = filePattern ? limit * 2 : limit;
      const raw = await this.store.search(queryVector, fetchLimit);

      if (raw.length === 0) return [];

      // Filter by glob pattern if provided
      const filtered = filePattern
        ? raw.filter((r) => globMatch(r.record.filePath, filePattern))
        : raw;

      // Normalize distances to 0–1 similarity (distance is cosine distance: lower = better)
      // Convert distance to score: score = 1 - (distance / maxDistance)
      const maxDist = Math.max(...filtered.map((r) => r.distance), 1);

      const results: SearchResult[] = filtered.slice(0, limit).map((r) => ({
        filePath: r.record.filePath,
        content: r.record.content,
        score: maxDist > 0 ? 1 - r.distance / maxDist : 1,
        startLine: r.record.startLine,
        endLine: r.record.endLine,
        chunkName: r.record.chunkName,
        chunkType: r.record.chunkType,
        language: r.record.language,
        source: 'semantic' as const,
      }));

      return results;
    } catch (err) {
      process.stderr.write(`SemanticSearch error: ${err}\n`);
      return [];
    }
  }
}
