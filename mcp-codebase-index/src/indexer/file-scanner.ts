/**
 * Recursively discovers source files in a directory.
 * Respects .gitignore patterns and skips binary files and common non-code directories.
 */

import fs from 'fs';
import path from 'path';
import { GitignoreFilter } from '../utils/gitignore-filter.js';
import { isBinaryExtension, detectLanguage } from '../utils/language-detector.js';

// Directories always skipped regardless of .gitignore
const ALWAYS_SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '__pycache__',
  '.venv', 'venv', '.next', '.nuxt', 'coverage', '.nyc_output',
  '.index', // our own index directory
]);

/** Default max file size: 1 MB */
const DEFAULT_MAX_FILE_SIZE = 1024 * 1024;

export interface ScannedFile {
  /** Absolute path to the file */
  path: string;
  /** Path relative to the root directory (forward slashes) */
  relativePath: string;
  /** File extension without leading dot, e.g. "ts" */
  extension: string;
  /** Tree-sitter language name, or null for unsupported types */
  language: string | null;
}

export interface ScanOptions {
  maxFileSizeBytes?: number;
  /** Additional glob-style patterns to exclude */
  extraExcludePatterns?: string[];
}

/**
 * Scan a directory recursively and return all indexable source files.
 * @param rootPath Absolute path to the repository root
 * @param options Optional scan configuration
 */
export function scanFiles(rootPath: string, options: ScanOptions = {}): ScannedFile[] {
  const maxSize = options.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE;
  const gitignoreFilter = new GitignoreFilter(rootPath);
  const results: ScannedFile[] = [];

  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      process.stderr.write(`Warning: cannot read directory ${dir}: ${err}\n`);
      return;
    }

    for (const entry of entries) {
      const absolutePath = path.join(dir, entry.name);
      const relativePath = path.relative(rootPath, absolutePath).split(path.sep).join('/');

      if (entry.isDirectory()) {
        // Skip hard-coded excluded directories
        if (ALWAYS_SKIP_DIRS.has(entry.name)) continue;
        // Skip gitignored directories
        if (gitignoreFilter.isIgnored(relativePath + '/')) continue;
        walk(absolutePath);
        continue;
      }

      if (!entry.isFile()) continue;

      // Skip gitignored files
      if (gitignoreFilter.isIgnored(relativePath)) continue;

      const ext = path.extname(entry.name).replace(/^\./, '').toLowerCase();

      // Skip binary files
      if (isBinaryExtension(ext)) continue;

      // Skip files that exceed max size
      try {
        const stat = fs.statSync(absolutePath);
        if (stat.size > maxSize) continue;
      } catch {
        continue;
      }

      const language = detectLanguage(ext);
      results.push({
        path: absolutePath,
        relativePath,
        extension: ext,
        language,
      });
    }
  }

  walk(rootPath);
  return results;
}
