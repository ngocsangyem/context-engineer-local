/**
 * Approximate token counting for English text and code.
 * Uses the heuristic: 1 token ≈ 4 characters.
 * Good enough for chunk size limits and repo-map budget calculations.
 */

const CHARS_PER_TOKEN = 4;

/**
 * Estimate the number of tokens in a string.
 * @param text Input text or code
 * @returns Approximate token count
 */
export function countTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Check if text exceeds a token budget.
 * @param text Input text
 * @param maxTokens Maximum allowed tokens
 */
export function exceedsTokenLimit(text: string, maxTokens: number): boolean {
  return countTokens(text) > maxTokens;
}

/**
 * Truncate text to fit within a token budget (by character approximation).
 * @param text Input text
 * @param maxTokens Maximum allowed tokens
 * @returns Truncated text
 */
export function truncateToTokenLimit(text: string, maxTokens: number): string {
  const maxChars = maxTokens * CHARS_PER_TOKEN;
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars);
}

/**
 * Estimate tokens for an array of strings (e.g. batch of chunks).
 */
export function countBatchTokens(texts: string[]): number {
  return texts.reduce((sum, t) => sum + countTokens(t), 0);
}
