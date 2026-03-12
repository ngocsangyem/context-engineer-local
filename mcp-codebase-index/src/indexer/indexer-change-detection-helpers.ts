/**
 * Change detection helpers for IndexerOrchestrator.
 * Provides git-based and mtime-based pre-filters to avoid reading unchanged files.
 *
 * Tiered approach:
 *   Tier 1: git diff  — identifies changed files without reading content
 *   Tier 2: mtime     — stat-based check against stored last_indexed timestamp
 *   Tier 3: hash      — authoritative check (handled in indexer-file-processor)
 */

import fs from 'fs';
import { GitChangeDetector } from './git-change-detector.js';
import type { MetadataStore } from '../storage/metadata-store.js';

/**
 * Build a set of git-changed file paths using git diff + untracked files.
 * Returns null if the directory is not a git repo or git fails.
 *
 * @param rootPath    Absolute path to the repository root
 * @param metadataStore Used to get last index timestamp for "since" range
 * @param log         Optional logger function
 */
export async function buildGitChangedSet(
  rootPath: string,
  metadataStore: MetadataStore,
  log?: (msg: string) => void
): Promise<Set<string> | null> {
  const detector = new GitChangeDetector(rootPath);
  if (!detector.isGitRepo()) return null;

  try {
    const lastTs = metadataStore.getLastIndexTimestamp();
    const result = await detector.getChangedFiles(lastTs ?? undefined);
    const allChanged = new Set([...result.changed, ...result.untracked]);
    log?.(`Git change detection: ${allChanged.size} changed/untracked, ${result.deleted.length} deleted.`);
    return allChanged;
  } catch {
    return null;
  }
}

/**
 * Tier 2 mtime fast-skip: returns true if a file can safely be skipped
 * without reading its content.
 *
 * Skip condition: file mtime <= last_indexed AND git says file is unchanged.
 * Hash comparison (Tier 3) is the final authority in indexer-file-processor.
 *
 * @param filePath           Absolute path of the file to check
 * @param gitChangedSet      Set of git-changed paths (null = no git, use mtime only)
 * @param lastIndexedMap     Pre-loaded map of filePath → last_indexed timestamp
 */
export function canSkipByMtime(
  filePath: string,
  gitChangedSet: Set<string> | null,
  lastIndexedMap: Map<string, number>
): boolean {
  // If git says it changed, never skip
  if (gitChangedSet !== null && gitChangedSet.has(filePath)) return false;

  const lastIndexed = lastIndexedMap.get(filePath);
  if (lastIndexed === undefined) return false; // never indexed → must process

  try {
    const stat = fs.statSync(filePath);
    // mtime older than last_indexed means file hasn't changed since last index
    return stat.mtimeMs <= lastIndexed;
  } catch {
    return false; // can't stat → process it
  }
}

/**
 * For incremental indexFiles(), narrow the provided list using git diff.
 * Falls back to the full list if git is unavailable.
 *
 * Always includes files with no stored hash (never indexed before).
 *
 * @param rootPath      Absolute path to the repository root
 * @param filePaths     Candidate file paths to filter
 * @param metadataStore Used to check if a file has been indexed before
 * @param log           Optional logger function
 */
export async function filterByGitChanges(
  rootPath: string,
  filePaths: string[],
  metadataStore: MetadataStore,
  log?: (msg: string) => void
): Promise<string[]> {
  const detector = new GitChangeDetector(rootPath);
  if (!detector.isGitRepo()) return filePaths;

  try {
    const result = await detector.getChangedFiles();
    const changedSet = new Set([...result.changed, ...result.untracked]);

    const filtered = filePaths.filter((fp) => {
      if (changedSet.has(fp)) return true;
      // Include files with no stored hash (never indexed)
      return metadataStore.getFileHash(fp) === null;
    });

    log?.(`Git filter: ${filtered.length}/${filePaths.length} files need processing.`);
    // Safety: if all files had hashes and none were in changedSet, still process them all
    return filtered.length > 0 ? filtered : filePaths;
  } catch {
    return filePaths;
  }
}
