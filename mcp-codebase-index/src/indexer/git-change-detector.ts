/**
 * Git-based fast change detection for incremental indexing.
 * Uses `git diff` and `git ls-files` to identify changed/added/deleted files
 * without reading file contents. Falls back gracefully if not a git repo.
 */

import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

export interface GitChangedFiles {
  /** Modified or added files (absolute paths) */
  changed: string[];
  /** Deleted files (absolute paths) */
  deleted: string[];
  /** Untracked files (absolute paths) */
  untracked: string[];
}

export class GitChangeDetector {
  constructor(private readonly rootPath: string) {}

  /**
   * Check if the rootPath is inside a git repository.
   */
  isGitRepo(): boolean {
    try {
      execFileSync('git', ['-C', this.rootPath, 'rev-parse', '--is-inside-work-tree'], {
        stdio: 'pipe',
        timeout: 5000,
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get files changed since a given epoch timestamp (ms).
   * Includes unstaged, staged, and untracked changes.
   * @param sinceMs Optional epoch ms — if provided, finds commits since that time
   */
  async getChangedFiles(sinceMs?: number): Promise<GitChangedFiles> {
    const changedSet = new Set<string>();
    const deletedSet = new Set<string>();
    const untracked: string[] = [];

    try {
      // Unstaged + staged modified/added/renamed
      const diffArgs = ['diff', '--name-only', '--diff-filter=ACMR', 'HEAD'];
      const diffOut = this.runGit(diffArgs);
      for (const rel of diffOut) {
        changedSet.add(path.resolve(this.rootPath, rel));
      }

      // Deleted files (staged or committed)
      const deletedArgs = ['diff', '--name-only', '--diff-filter=D', 'HEAD'];
      const deletedOut = this.runGit(deletedArgs);
      for (const rel of deletedOut) {
        deletedSet.add(path.resolve(this.rootPath, rel));
      }

      // Commits since sinceMs (if provided)
      if (sinceMs !== undefined && sinceMs > 0) {
        const sinceDate = new Date(sinceMs).toISOString();
        const logArgs = ['diff', '--name-only', '--diff-filter=ACMRD', `HEAD@{${sinceDate}}`, 'HEAD'];
        try {
          const logOut = this.runGit(logArgs);
          for (const rel of logOut) {
            const abs = path.resolve(this.rootPath, rel);
            if (!changedSet.has(abs) && !deletedSet.has(abs)) {
              // Check if file exists to categorize as changed or deleted
              if (fs.existsSync(abs)) {
                changedSet.add(abs);
              } else {
                deletedSet.add(abs);
              }
            }
          }
        } catch {
          // sinceDate ref might not exist; ignore
        }
      }

      // Untracked files (new files not yet staged)
      const untrackedArgs = ['ls-files', '--others', '--exclude-standard'];
      const untrackedOut = this.runGit(untrackedArgs);
      for (const rel of untrackedOut) {
        untracked.push(path.resolve(this.rootPath, rel));
      }
    } catch (err) {
      process.stderr.write(`[git-change-detector] git command failed: ${err}\n`);
      return { changed: [], deleted: [], untracked: [] };
    }

    return { changed: [...changedSet], deleted: [...deletedSet], untracked };
  }

  /**
   * Get all files currently tracked by git (for initial index scope).
   * Returns absolute paths.
   */
  async getTrackedFiles(): Promise<string[]> {
    try {
      const out = this.runGit(['ls-files']);
      return out.map((rel) => path.resolve(this.rootPath, rel));
    } catch {
      return [];
    }
  }

  /** Run a git command and return trimmed non-empty lines. */
  private runGit(args: string[]): string[] {
    const out = execFileSync('git', ['-C', this.rootPath, ...args], {
      stdio: 'pipe',
      timeout: 10000,
      encoding: 'utf-8',
    });
    return out
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
  }
}
