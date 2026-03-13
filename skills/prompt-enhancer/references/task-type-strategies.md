# Task Type Strategies

Retrieval strategy per task type: which MCP tools to call, in what order, how to weight results, and intensity defaults.

## Strategy Table

| Task Type | Retrieval Mode | Primary Tool | Secondary Tools | Default Intensity | Parallel Tools | Context Focus |
|-----------|---------------|-------------|-----------------|-------------------|----------------|---------------|
| debug | MCP-first | search_codebase | get_recent_changes, get_file_summary, get_call_graph | standard | search + recent_changes in parallel, then file_summary, then call_graph | Error-related code, recent diffs |
| coding | MCP-first | search_codebase | get_dependencies, search_symbols | standard | search + deps + symbols in parallel | Related patterns, import graph |
| refactor | **Hybrid** | get_dependencies | get_repo_map, search_codebase, get_call_graph | standard | MCP + file-tools in parallel | Full dependency graph, affected files |
| review | **Hybrid** | get_repo_map | get_file_summary | standard | MCP + file-tools in parallel | Architecture overview, file outlines |
| research | MCP-first | get_repo_map | search_codebase | light | map + search in parallel | Codebase conventions, patterns |

**Retrieval modes:**
- **MCP-first**: Query MCP → apply quality gates → fallback to file-tools if needed
- **Hybrid**: Query MCP + file-tools in parallel → merge results by file path (used for high-stakes tasks where missing a consumer/caller is costly)

---

## debug

**Goal:** Locate the defect, understand recent history, surface the affected code path.

**Tool sequence:**
1. `search_codebase(query)` + `get_recent_changes(files)` — run in parallel
2. `get_file_summary(filePath)` — after identifying the target file from step 1
3. `get_call_graph(symbol, direction="callers")` — trace error propagation

**Token budget split (4096 default):**
- 1638 tokens → search_codebase (40%)
- 1024 tokens → get_recent_changes (25%)
- 819 tokens → get_file_summary (20%)
- 615 tokens → get_call_graph (15%)

**Intensity behavior:**
- Light: search_codebase only, skip recent_changes and summary
- Standard: full tool sequence with verification
- Deep: full sequence + investigate_before_answering + grounding

---

## coding

**Goal:** Understand existing patterns and import graph before writing new code.

**Tool sequence:**
1. `search_codebase(query)` + `get_dependencies(filePath)` + `search_symbols(query)` — run in parallel

**Token budget split (4096 default):**
- 2253 tokens → search_codebase (55%)
- 1024 tokens → get_dependencies (25%)
- 819 tokens → search_symbols (20%)

**Intensity behavior:**
- Light: search_codebase only
- Standard: full sequence + anti_overengineering block
- Deep: full sequence + anti_overengineering + investigate + grounding

---

## refactor

**Goal:** Map all callers and dependents before restructuring to avoid breaking changes.

**Hybrid tool sequence (parallel tracks):**
1. **MCP track:** `get_dependencies(filePath)` + `get_repo_map(directory)` + `search_codebase(query)` + `get_call_graph(symbol)` — all in parallel
2. **File-tool track:** `Grep(pattern="{SymbolName}", glob="*.{ext}")` — deterministic consumer search
3. **Merge:** Dedupe by file path. MCP results with score ≥0.5 take priority. File-tool results fill gaps.

**Why hybrid:** Missing a consumer during refactor causes runtime breakage. File-tools provide deterministic recall (find ALL matches); MCP provides semantic ranking (find RELEVANT matches). Together: complete + ranked.

**Token budget split (4096 default):**
- 1229 tokens → get_dependencies (30%)
- 1024 tokens → get_repo_map (25%)
- 1024 tokens → search_codebase (25%)
- 819 tokens → get_call_graph (20%)

**Intensity behavior:**
- Light: get_dependencies only (MCP-first, no hybrid)
- Standard: hybrid sequence + anti_overengineering block
- Deep: hybrid sequence + anti_overengineering + investigate + grounding

---

## review

**Goal:** Build a structural picture of the module before critiquing individual files.

**Hybrid tool sequence (parallel tracks):**
1. **MCP track:** `get_repo_map(directory)` + `get_file_summary(filePath)` — run in parallel
2. **File-tool track:** `Read(filePath)` for structural extraction if `get_file_summary` fails quality gate
3. **Merge:** Use MCP results when quality passes, file-tool results otherwise.

**Token budget split (4096 default):**
- 2048 tokens → get_repo_map (full module map)
- 1638 tokens → get_file_summary / Read-based outline (merged)
- 410 tokens → search_codebase (spot-check if needed)

**Intensity behavior:**
- Light: get_repo_map only (MCP-first, no hybrid)
- Standard: hybrid sequence with verification
- Deep: hybrid sequence + investigate + grounding

---

## research

**Goal:** Understand codebase conventions and locate relevant patterns before explaining.

**Tool sequence:**
1. `get_repo_map(directory)` + `search_codebase(query)` — run in parallel

**Token budget split (4096 default):**
- 2048 tokens → get_repo_map (broad directory overview)
- 2048 tokens → search_codebase (top 4-6 representative snippets)

**Intensity behavior:**
- Light (default): get_repo_map only, minimal scaffolding
- Standard: full sequence with grounding
- Deep: full sequence + investigate + grounding

---

## Fallback Behavior (MCP Unavailable)

When the MCP server cannot be reached:

1. Skip all MCP tool calls
2. Keep all behavioral blocks (investigate_before_answering, grounding, anti_overengineering, verification)
3. Direct Claude to use built-in file tools: Read, Grep, Glob for context discovery
4. Output notice: `[MCP codebase index not available — using file-system tools for context]`
5. The enhanced prompt remains high quality thanks to the behavioral framework blocks

The script (`scripts/enhance-prompt.py`) always produces a valid enhanced prompt even without MCP context.

---

## Quality Gates

When MCP tools return results, assess quality before injecting into the prompt. Low-quality results waste token budget and can mislead the agent.

### Per-Tool Quality Checks

**search_codebase:**
- PASS: At least 1 result with score ≥0.5, AND result file paths seem relevant to the query
- FAIL: All scores <0.3, OR top result is clearly unrelated (test fixture, config, unrelated module)
- Fallback: Grep with extracted keywords from query + file-type glob filter

**get_file_summary:**
- PASS: Returns function/class names, symbol count, or structural outline
- FAIL: Returns only the file path or empty content
- Fallback: Read the file directly, extract structure from source

**get_dependencies:**
- PASS: At least one import OR one dependent found
- FAIL: Both imports and imported-by are empty for a non-trivial file
- Fallback: Grep for `import.*{filename}` and `from.*{filename}` patterns

**get_repo_map:**
- PASS: Returns multiple files with symbol information
- FAIL: Empty or single meaningless entry
- Fallback: Glob for file listing + Read key files

### Cascading Degradation

| Failed Tools | Action |
|-------------|--------|
| 1 tool | Substitute that tool's results with file-tool fallback |
| 2+ tools | Switch to full file-tools mode for all remaining queries |
| All tools | Same as "MCP Unavailable" — file-tools only |

Token budget remains the same regardless of which tools provide the context.

---

## Merge Strategy (Hybrid Mode)

When running MCP + file-tools in parallel for refactor/review tasks:

1. **Collect** all results from both tracks
2. **Dedupe** by file path — if same file appears in both, keep the one with more detail
3. **Rank** MCP results by score; file-tool results get default score of 0.80 (deterministic match = high confidence)
4. **Trim** to token budget — prioritize high-score MCP results, then file-tool gap-fillers
5. **Format** using same `<document>` pattern from context-injection-patterns.md

File-tool results use the same `<document index>` structure as MCP results for seamless merging.

---

## Framework-Aware Query Hints

When a task targets a specific file or symbol, generate framework-appropriate Grep patterns for the file-tool track (hybrid mode) or fallback queries (MCP-first mode).

### Detection Heuristic

| File Extension | Framework | Consumer Patterns to Grep |
|---------------|-----------|---------------------------|
| `.vue` | Vue SFC | `<ComponentName`, `import ComponentName`, `components: { ComponentName` |
| `.tsx`, `.jsx` | React | `<ComponentName`, `import ComponentName`, `import { ComponentName` |
| `.svelte` | Svelte | `<ComponentName`, `import ComponentName` |
| `.py` | Python | `from module import ClassName`, `import module`, `ClassName(` |
| `.go` | Go | `package.FunctionName(`, `import "module"` |
| `.ts`, `.js` | TypeScript/JS | `import { SymbolName`, `import SymbolName`, `require("module")` |

### Query Generation Rules

**For component-based frameworks (Vue, React, Svelte):**
1. Extract PascalCase component name from file path (e.g., `AspireFilter.vue` → `AspireFilter`)
2. Primary Grep: `pattern="{ComponentName}"`, `glob="*.{vue,tsx,jsx,svelte}"`
3. Secondary Grep: `pattern="import.*{ComponentName}"`, `glob="*.{vue,tsx,jsx,ts,js}"`

**For module-based languages (Python, Go, TS/JS):**
1. Extract symbol name from task description or file path
2. Primary Grep: `pattern="{SymbolName}"`, `glob="*.{ext}"`
3. Secondary Grep: `pattern="import.*{module_name}"`, `glob="*.{ext}"`

**For dependency analysis (all frameworks):**
1. Extract filename stem (no extension)
2. Grep for import patterns: `pattern="from.*{stem}|import.*{stem}"`, `glob="*.{ext}"`
3. This replaces `get_dependencies` fallback when MCP returns empty

### When to Use
- Always for the file-tool track in hybrid mode (refactor, review)
- As fallback queries when MCP `search_codebase` fails quality gate
- When MCP `get_dependencies` returns empty for a non-trivial file
