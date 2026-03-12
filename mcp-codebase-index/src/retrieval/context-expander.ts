/**
 * Graph-based context expansion for search results.
 * Enriches top results by appending caller/callee context from the call graph,
 * respecting a token budget to avoid bloating the assembled context.
 */

import type { MetadataStore } from '../storage/metadata-store.js';
import type { SearchResult } from './semantic-search.js';

/** Approximate chars-per-token ratio for token budget estimation */
const CHARS_PER_TOKEN = 4;

/** How many top results to expand (avoid expanding all N results) */
const MAX_RESULTS_TO_EXPAND = 3;

/** Score assigned to expanded (secondary) context results */
const EXPANSION_SCORE = 0.5;

/**
 * Estimate token count from a string using a simple char/token ratio.
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Build a minimal SearchResult for a callee symbol found in the symbol table.
 * Falls back to a stub result when the symbol isn't in the index.
 */
function makeCalleeResult(
  calleeName: string,
  calleeFile: string | null,
  store: MetadataStore
): SearchResult | null {
  if (!calleeFile) return null;

  try {
    const symbols = store.getFileSymbols(calleeFile);
    const match = symbols.find(
      (s) => s.name === calleeName || s.qualifiedName === calleeName
    );
    if (!match) return null;

    return {
      filePath: match.filePath,
      content: match.signature,
      score: EXPANSION_SCORE,
      startLine: match.startLine,
      endLine: match.endLine,
      chunkName: match.qualifiedName,
      chunkType: match.kind,
      language: match.language,
      source: 'structural' as const,
    };
  } catch {
    return null;
  }
}

/**
 * Expand search results with call-graph context.
 *
 * For each of the top MAX_RESULTS_TO_EXPAND results:
 * 1. Look up callees made from that file/symbol via MetadataStore
 * 2. Look up callers of the symbol name
 * 3. Resolve callee symbols to SearchResult stubs
 * 4. Append within the remaining token budget
 *
 * Original results are always included; expansion results are appended after.
 *
 * @param results    Primary search results (sorted by relevance)
 * @param store      MetadataStore for call edge and symbol lookups
 * @param maxTokens  Approximate token budget for the total returned set
 */
export function expandContext(
  results: SearchResult[],
  store: MetadataStore,
  maxTokens = 4000
): SearchResult[] {
  if (results.length === 0) return results;

  // Compute token usage of primary results
  let usedTokens = results.reduce(
    (sum, r) => sum + estimateTokens(r.content),
    0
  );

  const expanded: SearchResult[] = [...results];
  const seenKeys = new Set<string>(
    results.map((r) => `${r.filePath}:${r.startLine}`)
  );

  const toExpand = results.slice(0, MAX_RESULTS_TO_EXPAND);

  for (const result of toExpand) {
    if (usedTokens >= maxTokens) break;

    // --- Callees: what does this result's file/chunk call? ---
    try {
      const callees = store.getCallees(result.filePath, result.chunkName, 10);
      for (const edge of callees) {
        if (usedTokens >= maxTokens) break;
        const calleeResult = makeCalleeResult(edge.calleeName, edge.calleeFile, store);
        if (!calleeResult) continue;

        const key = `${calleeResult.filePath}:${calleeResult.startLine}`;
        if (seenKeys.has(key)) continue;

        const tokens = estimateTokens(calleeResult.content);
        if (usedTokens + tokens > maxTokens) break;

        seenKeys.add(key);
        expanded.push(calleeResult);
        usedTokens += tokens;
      }
    } catch {
      // non-fatal: call edge lookup failure shouldn't abort expansion
    }

    // --- Callers: who calls this result's chunk? ---
    if (result.chunkName && usedTokens < maxTokens) {
      try {
        const callers = store.getCallers(result.chunkName, 5);
        for (const edge of callers) {
          if (usedTokens >= maxTokens) break;

          // Represent caller as a minimal stub pointing to its call site
          const callerKey = `${edge.callerFile}:${edge.callerLine}`;
          if (seenKeys.has(callerKey)) continue;

          const callerContent = `${edge.callerSymbol} calls ${edge.calleeName} (line ${edge.callerLine})`;
          const tokens = estimateTokens(callerContent);
          if (usedTokens + tokens > maxTokens) break;

          seenKeys.add(callerKey);
          expanded.push({
            filePath: edge.callerFile,
            content: callerContent,
            score: EXPANSION_SCORE,
            startLine: edge.callerLine,
            endLine: edge.callerLine,
            chunkName: edge.callerSymbol,
            source: 'structural' as const,
          });
          usedTokens += tokens;
        }
      } catch {
        // non-fatal
      }
    }
  }

  return expanded;
}
