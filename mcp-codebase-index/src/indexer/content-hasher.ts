/**
 * SHA-256 content hashing for change detection.
 * Compares current file hash against stored hash to determine if re-indexing is needed.
 */

import crypto from 'crypto';
import fs from 'fs';

/**
 * Compute SHA-256 hash of a string (file content).
 * @param content Raw file content as string
 * @returns Hex-encoded SHA-256 hash
 */
export function hashContent(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf-8').digest('hex');
}

/**
 * Compute SHA-256 hash of a file by reading it from disk.
 * @param filePath Absolute path to the file
 * @returns Hex-encoded SHA-256 hash
 * @throws If the file cannot be read
 */
export function hashFile(filePath: string): string {
  const content = fs.readFileSync(filePath, 'utf-8');
  return hashContent(content);
}

/**
 * Determine whether a file's content has changed compared to a stored hash.
 * @param currentContent Current file content
 * @param storedHash Previously stored SHA-256 hash (or null if not indexed)
 * @returns true if content has changed and re-indexing is needed
 */
export function hasContentChanged(currentContent: string, storedHash: string | null): boolean {
  if (storedHash === null) return true;
  return hashContent(currentContent) !== storedHash;
}
