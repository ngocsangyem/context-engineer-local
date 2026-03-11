# Task Type Strategies

Retrieval strategy per task type: which MCP tools to call, in what order, how to weight results, and intensity defaults.

## Strategy Table

| Task Type | Primary Tool | Secondary Tools | Default Intensity | Parallel Tools | Context Focus |
|-----------|-------------|-----------------|-------------------|----------------|---------------|
| debug | search_codebase | get_recent_changes, get_file_summary | standard | search + recent_changes in parallel, then file_summary | Error-related code, recent diffs |
| coding | search_codebase | get_dependencies | standard | search + deps in parallel | Related patterns, import graph |
| refactor | get_dependencies | get_repo_map, search_codebase | standard | All 3 in parallel | Full dependency graph, affected files |
| review | get_repo_map | get_file_summary | standard | map + summary in parallel | Architecture overview, file outlines |
| research | get_repo_map | search_codebase | light | map + search in parallel | Codebase conventions, patterns |

---

## debug

**Goal:** Locate the defect, understand recent history, surface the affected code path.

**Tool sequence:**
1. `search_codebase(query)` + `get_recent_changes(files)` — run in parallel
2. `get_file_summary(filePath)` — after identifying the target file from step 1

**Token budget split (4096 default):**
- 2048 tokens → search_codebase (top 3-5 snippets)
- 1229 tokens → get_recent_changes (last 5-10 relevant commits)
- 819 tokens → get_file_summary (function/class outline)

**Intensity behavior:**
- Light: search_codebase only, skip recent_changes and summary
- Standard: full tool sequence with verification
- Deep: full sequence + investigate_before_answering + grounding

---

## coding

**Goal:** Understand existing patterns and import graph before writing new code.

**Tool sequence:**
1. `search_codebase(query)` + `get_dependencies(filePath)` — run in parallel

**Token budget split (4096 default):**
- 2458 tokens → search_codebase (top 4-6 snippets)
- 1229 tokens → get_dependencies (direct imports + importers)
- 409 tokens → get_repo_map (summary of affected area)

**Intensity behavior:**
- Light: search_codebase only
- Standard: full sequence + anti_overengineering block
- Deep: full sequence + anti_overengineering + investigate + grounding

---

## refactor

**Goal:** Map all callers and dependents before restructuring to avoid breaking changes.

**Tool sequence:**
1. `get_dependencies(filePath)` + `get_repo_map(directory)` + `search_codebase(query)` — all in parallel

**Token budget split (4096 default):**
- 1638 tokens → get_dependencies (full graph including transitive callers)
- 1229 tokens → get_repo_map (directory-level overview)
- 1229 tokens → search_codebase (usage examples of the target symbol)

**Intensity behavior:**
- Light: get_dependencies only
- Standard: full sequence + anti_overengineering block
- Deep: full sequence + anti_overengineering + investigate + grounding

---

## review

**Goal:** Build a structural picture of the module before critiquing individual files.

**Tool sequence:**
1. `get_repo_map(directory)` + `get_file_summary(filePath)` — run in parallel

**Token budget split (4096 default):**
- 2048 tokens → get_repo_map (full module map)
- 1638 tokens → get_file_summary (outlines for 3-5 key files)
- 410 tokens → search_codebase (spot-check if needed)

**Intensity behavior:**
- Light: get_repo_map only
- Standard: full sequence with verification
- Deep: full sequence + investigate + grounding

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
