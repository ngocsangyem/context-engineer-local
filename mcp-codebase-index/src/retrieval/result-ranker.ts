/**
 * Score fusion and deduplication for multi-source search results.
 * Merges semantic, keyword, and structural results using weighted scoring.
 * Deduplicates overlapping line ranges within the same file.
 */

import type { SearchResult } from './semantic-search.js';

export interface RankWeights {
  semantic: number;
  keyword: number;
  structural: number;
}

const DEFAULT_WEIGHTS: RankWeights = {
  semantic: 0.5,
  keyword: 0.3,
  structural: 0.2,
};

/** Check whether two line ranges overlap by more than 50% of the smaller range */
function overlapsSignificantly(
  aStart: number, aEnd: number,
  bStart: number, bEnd: number
): boolean {
  const overlapStart = Math.max(aStart, bStart);
  const overlapEnd = Math.min(aEnd, bEnd);
  if (overlapEnd < overlapStart) return false;
  const overlapLen = overlapEnd - overlapStart + 1;
  const smallerLen = Math.min(aEnd - aStart + 1, bEnd - bStart + 1);
  return overlapLen / smallerLen > 0.5;
}

/**
 * Merge and rank search results from multiple sources.
 *
 * Algorithm:
 * 1. Apply source weight multiplier to each result's score
 * 2. Group results by file path
 * 3. Within each file, deduplicate overlapping line ranges (keep higher weighted score)
 * 4. Sort globally by weighted score descending
 */
export function rankAndMerge(
  results: SearchResult[],
  weights: RankWeights = DEFAULT_WEIGHTS
): SearchResult[] {
  if (results.length === 0) return [];

  // Apply weight multipliers
  const weighted = results.map((r) => ({
    ...r,
    score: r.score * (weights[r.source] ?? 0.2),
  }));

  // Group by file path
  const byFile = new Map<string, SearchResult[]>();
  for (const r of weighted) {
    const existing = byFile.get(r.filePath) ?? [];
    existing.push(r);
    byFile.set(r.filePath, existing);
  }

  const deduplicated: SearchResult[] = [];

  for (const fileResults of byFile.values()) {
    // Sort by score descending so highest-scored wins dedup
    fileResults.sort((a, b) => b.score - a.score);

    const kept: SearchResult[] = [];
    for (const candidate of fileResults) {
      const overlaps = kept.some((k) =>
        overlapsSignificantly(
          k.startLine, k.endLine,
          candidate.startLine, candidate.endLine
        )
      );
      if (!overlaps) kept.push(candidate);
    }

    deduplicated.push(...kept);
  }

  // Final sort by weighted score descending
  deduplicated.sort((a, b) => b.score - a.score);

  return deduplicated;
}
