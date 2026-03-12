/**
 * Resolve raw import source paths to absolute file paths on disk.
 * Handles relative imports with extension fallbacks.
 * Skips external packages (npm/pip/cargo deps).
 */

import fs from 'fs';
import path from 'path';
import type { RawImport } from './import-parser.js';
import type { DependencyEdge } from '../storage/metadata-store.js';

/** Extensions tried in order when resolving imports without an explicit extension. */
const RESOLVE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs'];

/** Index file names tried when an import resolves to a directory. */
const INDEX_FILES = ['index.ts', 'index.tsx', 'index.js', 'index.jsx'];

/**
 * Resolve a list of raw imports from a source file to DependencyEdge records.
 * Skips imports that cannot be resolved to a file on disk.
 *
 * @param fromFile  Absolute path of the importing file
 * @param rawImports  Output from parseImports()
 * @returns Array of resolved DependencyEdge (kind='import', fromFile omitted — caller fills it)
 */
export function resolveImports(
  fromFile: string,
  rawImports: RawImport[]
): Omit<DependencyEdge, 'fromFile'>[] {
  const fromDir = path.dirname(fromFile);
  const edges: Omit<DependencyEdge, 'fromFile'>[] = [];

  for (const raw of rawImports) {
    // Skip external package imports (no leading ./ or ../ or /)
    if (!isRelativeImport(raw.sourcePath)) continue;

    const resolved = resolveRelativePath(fromDir, raw.sourcePath);
    if (!resolved) continue;

    edges.push({
      toFile: resolved,
      kind: 'import',
      symbols: raw.symbols,
      fromLine: raw.line,
    });
  }

  return edges;
}

/**
 * Resolve a single relative import path to an absolute file path.
 * Returns null if no matching file found on disk.
 */
export function resolveRelativePath(fromDir: string, importPath: string): string | null {
  const candidate = path.resolve(fromDir, importPath);

  // 1. Exact match (import already has extension)
  if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
    return candidate;
  }

  // 2. Try appending known extensions
  for (const ext of RESOLVE_EXTENSIONS) {
    const withExt = candidate + ext;
    if (fs.existsSync(withExt)) return withExt;
  }

  // 3. Try as directory with index file
  if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
    for (const indexFile of INDEX_FILES) {
      const indexPath = path.join(candidate, indexFile);
      if (fs.existsSync(indexPath)) return indexPath;
    }
  }

  // 4. Strip .js extension and retry with .ts (common in ESM TS projects)
  if (importPath.endsWith('.js')) {
    const tsVariant = candidate.slice(0, -3) + '.ts';
    if (fs.existsSync(tsVariant)) return tsVariant;
    const tsxVariant = candidate.slice(0, -3) + '.tsx';
    if (fs.existsSync(tsxVariant)) return tsxVariant;
  }

  return null;
}

/**
 * Return true if an import path is relative (starts with ./ or ../ or /).
 * External npm packages and bare specifiers return false.
 */
function isRelativeImport(importPath: string): boolean {
  return importPath.startsWith('./') ||
    importPath.startsWith('../') ||
    importPath.startsWith('/');
}
