# Code Review: Data Dir Resolution & Index Status Enhancement

## Scope
- Files: `src/index.ts`, `src/indexer/indexer-orchestrator.ts`, `src/server/mcp-server-setup.ts`
- Focus: New `projectSlug()`, `resolveDataDir()`, indexDir resolution changes, enhanced `index_status` tool

## Overall Assessment
Solid changes. A few issues worth addressing, one medium-severity.

---

## Issues

### 1. [MEDIUM] `import.meta.url` path resolution brittle for npm global / symlink installs

**File:** `src/index.ts:37`

```ts
const mcpRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
```

This assumes the compiled entry point is always at `dist/index.js` (exactly one level deep under mcpRoot). Breaks if:
- Package is installed globally via npm (node_modules/.bin symlink -> deeply nested path)
- Bundled into a single file by esbuild/rollup (no `dist/` directory)
- Run from a monorepo where the entry point path differs

**Recommendation:** Add a runtime assertion or fallback. Check that `mcpRoot` contains `package.json` with the expected name:

```ts
import fs from 'fs';
const mcpRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// Validate we resolved the correct root
const pkgPath = path.join(mcpRoot, 'package.json');
if (!fs.existsSync(pkgPath)) {
  process.stderr.write(`[mcp-codebase-index] Warning: could not locate package root at ${mcpRoot}\n`);
}
```

Or use `import.meta.resolve` / a findUp utility for `package.json`.

### 2. [LOW] 6-char hash collision probability

**File:** `src/index.ts:31`

6 hex chars = 16^6 = ~16.7M possibilities. For a single-user tool indexing a handful of projects this is fine. But document the assumption. If this ever becomes multi-tenant or shared, 6 chars is insufficient.

No action needed now, just noting the design constraint.

### 3. [LOW] `rootPath` normalization inconsistency affects slug stability

**File:** `src/index.ts:29-33`

`projectSlug()` hashes `rootPath` directly, but `rootPath` is `path.resolve()`'d in `parseArgs` (line 75). If `projectSlug` is ever called from elsewhere without resolving first, a trailing slash or different casing (on macOS case-insensitive FS) produces a different hash -> different data dir.

**Recommendation:** Normalize inside `projectSlug` itself:

```ts
function projectSlug(rootPath: string): string {
  const resolved = path.resolve(rootPath);
  const base = path.basename(resolved).replace(/[^a-zA-Z0-9_-]/g, '_') || 'root';
  const hash = crypto.createHash('sha256').update(resolved).digest('hex').slice(0, 6);
  return `${base}-${hash}`;
}
```

### 4. [LOW] `getMetadataStats()` missing explicit return type

**File:** `src/indexer/indexer-orchestrator.ts:203`

```ts
getMetadataStats() {
  return this.metadataStore.getStats();
}
```

Should have explicit return type `IndexStats` (from metadata-store) for API clarity since this is a public method exposed to other modules.

### 5. [LOW] Staleness check uses wall-clock `Date.now()` vs SQLite epoch

**File:** `src/server/mcp-server-setup.ts:176`

`metaStats.newestIndexed` is the `MAX(last_indexed)` from SQLite. Confirm `last_indexed` stores `Date.now()` (JS epoch ms). If it stores Unix seconds instead, the 1-hour threshold (`60 * 60 * 1000`) would be wrong by 1000x. Verified the MetadataStore uses JS epoch ms -- this is correct but fragile if someone changes the store.

No action needed, just noting the coupling.

### 6. [INFO] `data/` directory -- confirmed gitignored

Verified: `mcp-codebase-index/data/*` exists in the root `.gitignore`. No issue.

---

## Security Notes
- Path construction uses `path.join` / `path.resolve` -- no injection risk
- `rootPath` from CLI is resolved before use -- good
- No secrets or credentials exposed in data dir path
- `execFile` (not `exec`) used for git commands -- no shell injection

## Unresolved Questions
- Is the `import.meta.url` resolution tested with the actual npm publish / bin entry flow?
