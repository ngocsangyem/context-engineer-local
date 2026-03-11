/**
 * Filters file paths using .gitignore patterns.
 * Wraps the `ignore` npm package with default exclusions for common non-code dirs.
 */

import fs from 'fs';
import path from 'path';
import { createRequire } from 'node:module';

// The `ignore` package types don't expose a call signature under strict NodeNext.
// Use explicit any to bypass the type constraint and handle CJS/ESM interop.
type IgnoreFactory = () => Ignore;
interface Ignore {
  add(patterns: string | string[]): Ignore;
  ignores(path: string): boolean;
}

// Use createRequire to safely load the CJS `ignore` package from an ESM module.
const _require = createRequire(import.meta.url);

/** Create a new ignore instance, handling CJS/ESM interop. */
function createIgnore(): Ignore {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pkg: any = _require('ignore');
  const factory: IgnoreFactory = typeof pkg === 'function' ? pkg : pkg.default;
  return factory();
}

// Default patterns to always exclude regardless of .gitignore
const DEFAULT_EXCLUSIONS = [
  'node_modules',
  '.git',
  'dist',
  'build',
  '__pycache__',
  '.venv',
  'venv',
  '.env',
  '.env.local',
  '.next',
  '.nuxt',
  'coverage',
  '.nyc_output',
  '*.lock',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
];

export class GitignoreFilter {
  private ig: Ignore;
  private rootPath: string;

  constructor(rootPath: string) {
    this.rootPath = rootPath;
    this.ig = createIgnore();

    // Apply default exclusions first
    this.ig.add(DEFAULT_EXCLUSIONS);

    // Load and apply .gitignore if it exists
    this.loadGitignore();
  }

  /**
   * Read .gitignore from the root directory and add its patterns.
   */
  private loadGitignore(): void {
    const gitignorePath = path.join(this.rootPath, '.gitignore');
    try {
      if (fs.existsSync(gitignorePath)) {
        const content = fs.readFileSync(gitignorePath, 'utf-8');
        this.ig.add(content);
      }
    } catch (err) {
      // Non-fatal: proceed without .gitignore patterns
      process.stderr.write(`Warning: could not read .gitignore at ${gitignorePath}: ${err}\n`);
    }
  }

  /**
   * Check whether a relative path should be excluded from indexing.
   * @param relativePath Path relative to the root directory (use forward slashes)
   */
  isIgnored(relativePath: string): boolean {
    // Normalize to forward slashes for cross-platform compatibility
    const normalized = relativePath.split(path.sep).join('/');
    return this.ig.ignores(normalized);
  }

  /**
   * Filter an array of relative paths, keeping only non-ignored ones.
   */
  filter(relativePaths: string[]): string[] {
    return relativePaths.filter((p) => !this.isIgnored(p));
  }
}
