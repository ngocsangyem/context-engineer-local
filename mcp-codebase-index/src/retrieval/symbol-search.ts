/**
 * Symbol-table search strategy.
 * Performs exact and prefix lookups against the SQLite symbols index,
 * returning SearchResult objects compatible with result-ranker.
 */

import type { MetadataStore } from '../storage/metadata-store.js';
import type { SearchResult } from './semantic-search.js';

/** Score for an exact name match */
const SCORE_EXACT = 1.0;
/** Score for a prefix (non-exact) match */
const SCORE_PREFIX = 0.8;

/**
 * Search the symbol index for a query string.
 * Delegates to MetadataStore.searchSymbols (prefix match + ordering).
 * Returns results as SearchResult with source='structural' to reuse existing
 * weight handling in result-ranker without introducing a new source type.
 *
 * @param query   Symbol name query (exact or prefix)
 * @param store   MetadataStore instance
 * @param limit   Max results (default 10)
 * @param kind    Optional SymbolKind filter
 */
export function searchBySymbol(
  query: string,
  store: MetadataStore,
  limit = 10,
  kind?: string
): SearchResult[] {
  if (!query || query.trim().length === 0) return [];

  try {
    const normalized = query.trim();
    const symbols = store.searchSymbols(normalized, kind, limit);

    return symbols.map((sym) => {
      const isExact = sym.name === normalized || sym.qualifiedName === normalized;
      const score = isExact ? SCORE_EXACT : SCORE_PREFIX;

      // Build a content summary from the symbol signature and metadata
      const paramStr = sym.parameters
        ? `(${sym.parameters.map((p) => (p.type ? `${p.name}: ${p.type}` : p.name)).join(', ')})`
        : '';
      const returnStr = sym.returnType ? `: ${sym.returnType}` : '';
      const content = [
        `${sym.visibility === 'exported' ? 'export ' : ''}${sym.kind} ${sym.qualifiedName}${paramStr}${returnStr}`,
        sym.signature !== sym.qualifiedName ? sym.signature : '',
      ]
        .filter(Boolean)
        .join('\n');

      return {
        filePath: sym.filePath,
        content,
        score,
        startLine: sym.startLine,
        endLine: sym.endLine,
        chunkName: sym.qualifiedName,
        chunkType: sym.kind,
        language: sym.language,
        source: 'structural' as const,
      };
    });
  } catch (err) {
    process.stderr.write(`symbol-search error: ${err}\n`);
    return [];
  }
}
