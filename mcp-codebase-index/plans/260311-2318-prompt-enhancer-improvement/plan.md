---
title: "Improve prompt-enhancer skill with Claude Code best practices"
description: "Restructure prompt-enhancer to follow Anthropic prompting best practices: context-first ordering, intensity levels, investigate-before-answering, grounding, parallel tools, and anti-overengineering guidance."
status: complete
priority: P2
effort: 4h
branch: ""
tags: [prompt-engineering, skill, mcp, claude-code]
created: 2026-03-11
---

# Prompt Enhancer Improvement Plan

## Summary

Upgrade the `prompt-enhancer` skill to align with Anthropic's Claude Code prompting best practices. Key changes: restructure prompt ordering (context at top, query at bottom), add intensity levels, add `<investigate_before_answering>` and anti-overengineering blocks, improve verification, support parallel tool calls, and strengthen graceful degradation.

## Current State

| File | LOC | Role |
|------|-----|------|
| `SKILL.md` | 89 | Skill definition, task detection, MCP tool mapping |
| `scripts/enhance-prompt.py` | 257 | Deterministic prompt builder (stdlib-only Python) |
| `references/context-injection-patterns.md` | 230 | XML formatting rules per MCP tool |
| `references/task-type-strategies.md` | 162 | Per-task retrieval strategies |

## Problems with Current Implementation

1. **Wrong prompt ordering** -- `<objective>` comes first; best practices say longform context should be at top, query/instructions at bottom (up to 30% quality improvement)
2. **No intensity levels** -- prompt-leverage has Light/Standard/Deep; current skill treats all tasks identically
3. **No `<investigate_before_answering>`** -- best practice block missing entirely
4. **No grounding instruction** -- doesn't tell Claude to quote relevant code before answering
5. **No parallel tool guidance** -- doesn't use `<use_parallel_tool_calls>` when task uses 2+ independent MCP tools
6. **No anti-overengineering** -- no YAGNI/KISS guidance in enhanced prompts
7. **Weak verification** -- task-specific but doesn't use self-check pattern ("Before you finish, verify...")
8. **No `<document index="n">` pattern** -- code snippets lack structured indexing
9. **Context has no motivation** -- injected code doesn't explain WHY it's relevant
10. **Graceful degradation is thin** -- just skips context; should apply prompt-leverage framework fully

## Implementation Steps

### Step 1: Add intensity detection module

**File:** `scripts/detect-intensity.py` (new, ~40 LOC)

Extract intensity detection into its own module, reusable by both enhance-prompt.py and any future scripts.

```python
# Intensity levels: light, standard, deep
# Detection logic:
# - Keywords: "careful", "thorough", "deep dive", "production", "critical", "high stakes" -> deep
# - Task type heuristic: debug/refactor default to standard; research defaults to light
# - Prompt length > 200 chars suggests standard minimum
# - Explicit --intensity flag overrides all
```

Map intensity to behavior:
- **Light**: Objective + Work Style + Done Criteria only. No verification block. Minimal tool rules.
- **Standard**: All blocks. Standard verification. Parallel tools if applicable.
- **Deep**: All blocks + `<investigate_before_answering>` + grounding instruction + stronger verification + anti-overengineering for coding/refactor.

### Step 2: Restructure prompt ordering in enhance-prompt.py

**Current order:** objective -> work_style -> tool_rules -> context_budget -> verification -> done_criteria

**New order (context-first, query-last):**
1. `<codebase_context>` (placeholder/directive for MCP results) -- TOP
2. `<tool_rules>` (including parallel tool guidance)
3. `<investigate_before_answering>` (standard + deep only)
4. `<anti_overengineering>` (coding/refactor tasks, standard + deep only)
5. `<work_style>` (with intensity level)
6. `<grounding>` instruction (standard + deep only)
7. `<verification>` (strengthened self-check pattern)
8. `<objective>` -- BOTTOM (query at end per best practices)
9. `<done_criteria>` -- after objective

This restructuring puts longform data directives at top and the user's actual query at bottom.

### Step 3: Add new prompt blocks

#### 3a. `<investigate_before_answering>` block
```xml
<investigate_before_answering>
Never speculate about code you have not opened. If the user references a specific file,
read the file before answering. Investigate relevant files BEFORE answering questions
about the codebase. Give grounded, hallucination-free answers.
</investigate_before_answering>
```
Include for: standard and deep intensity.

#### 3b. `<anti_overengineering>` block
```xml
<anti_overengineering>
Apply YAGNI: implement only what is needed now, not what might be needed later.
Prefer the simplest solution that satisfies the requirements.
Do not add abstractions, interfaces, or layers unless they solve a concrete current problem.
Do not hard-code values just to pass tests -- implement general solutions.
</anti_overengineering>
```
Include for: coding and refactor tasks at standard+ intensity.

#### 3c. `<grounding>` instruction
```xml
<grounding>
When using injected codebase context, quote the relevant code snippets or symbols
before reasoning about them. This grounds your answer in the actual code rather than
assumptions.
</grounding>
```
Include for: standard and deep intensity.

#### 3d. `<use_parallel_tool_calls>` block
```xml
<use_parallel_tool_calls>
When multiple MCP tools need to be called and their inputs are independent,
call them in parallel rather than sequentially for faster context retrieval.
</use_parallel_tool_calls>
```
Include when: task type uses 2+ MCP tools with independent inputs (most tasks).

### Step 4: Strengthen verification block

Current verification is descriptive. Change to imperative self-check pattern:

```python
# Template:
# "Before you finish, verify:
#  1. [task-specific check]
#  2. [task-specific check]
#  3. Your answer is grounded in actual code, not assumptions.
#  4. No existing functionality is broken by your changes."
```

### Step 5: Update enhance-prompt.py structure

Refactor the main script to stay under 200 LOC by extracting:

| Module | Responsibility | Est. LOC |
|--------|---------------|----------|
| `scripts/enhance-prompt.py` | CLI + orchestration + `enhance()` | ~120 |
| `scripts/detect-intensity.py` | Intensity detection logic | ~40 |
| `scripts/prompt-blocks.py` | Block builders (investigate, grounding, anti-overengineering, verification, parallel tools) | ~80 |

Keep existing modules in `scripts/`:
- `enhance-prompt.py` imports from `detect-intensity.py` and `prompt-blocks.py`
- All stdlib-only, no external deps

Move constants (TASK_KEYWORDS, TASK_MCP_TOOLS, BUDGET_WEIGHTS, CONTEXT_FOCUS, WORK_STYLE) to `scripts/prompt-blocks.py` or keep in `enhance-prompt.py` depending on final LOC count.

### Step 6: Update context-injection-patterns.md

Changes:
1. Use `<document index="n">` pattern for multiple code snippets
2. Add relevance motivation per snippet (WHY this code matters)
3. Add grounding instruction reminder per section

**New snippet format:**
```xml
<codebase_context>
  <document index="1">
    <source>src/auth/token-manager.ts:45-72</source>
    <relevance>0.94</relevance>
    <reason>Contains the token refresh logic where the timeout bug likely originates</reason>
    <content>
      // ... code ...
    </content>
  </document>
  <document index="2">
    <source>src/middleware/auth-middleware.ts:12-28</source>
    <relevance>0.81</relevance>
    <reason>Calls TokenManager.refreshToken -- may need updating if the fix changes the API</reason>
    <content>
      // ... code ...
    </content>
  </document>
</codebase_context>
```

### Step 7: Update task-type-strategies.md

Add per task type:
1. **Default intensity** column (debug=standard, coding=standard, refactor=standard, review=standard, research=light)
2. **Parallel tools** column (which tools can run in parallel vs must be sequential)
3. **When to use examples** guidance (complex coding tasks benefit from 1-2 few-shot examples)

### Step 8: Update SKILL.md

1. Add intensity levels section (light/standard/deep)
2. Add new blocks to the workflow description
3. Update prompt ordering documentation
4. Add `--intensity` flag to script usage
5. Strengthen graceful degradation section -- when no MCP, apply full prompt-leverage framework (objective, work style, tool rules, output contract, verification, done criteria) instead of just "basic enhancement"
6. Add note about parallel tool calling

### Step 9: Graceful degradation improvement

When MCP server is unavailable, the enhanced prompt should still be high quality:

- Apply prompt-leverage framework blocks (from the reference skill)
- Include `<investigate_before_answering>` (tells Claude to use built-in file tools)
- Include `<anti_overengineering>` for coding tasks
- Include `<grounding>` (tells Claude to read actual files)
- Include strengthened `<verification>`
- Skip only: `<codebase_context>`, `<repo_structure>`, `<recent_changes>`, `<dependencies>` (MCP-dependent sections)
- Add notice: `[MCP codebase index not available -- using file-system tools for context]`

## File Change Summary

| File | Action | Key Changes |
|------|--------|-------------|
| `SKILL.md` | Update | Add intensity, new blocks, reorder docs, parallel tools, better degradation |
| `scripts/enhance-prompt.py` | Refactor | Reorder output (context-top, query-bottom), add intensity, import new modules, stay <200 LOC |
| `scripts/detect-intensity.py` | Create | Intensity detection: light/standard/deep based on keywords + task type |
| `scripts/prompt-blocks.py` | Create | Block builders: investigate, grounding, anti-overengineering, parallel tools, verification |
| `references/context-injection-patterns.md` | Update | `<document index="n">` pattern, relevance reasons, grounding reminders |
| `references/task-type-strategies.md` | Update | Add intensity, parallel tools, few-shot guidance columns |

## Success Criteria

- [x] Enhanced prompts place codebase context at top, objective/query at bottom
- [x] Intensity detection works: light tasks get minimal scaffolding, deep tasks get full framework
- [x] `<investigate_before_answering>` included for standard+ intensity
- [x] `<anti_overengineering>` included for coding/refactor at standard+
- [x] `<grounding>` instruction included for standard+
- [x] `<use_parallel_tool_calls>` included when 2+ independent MCP tools
- [x] Verification uses imperative self-check pattern
- [x] Context injection uses `<document index="n">` with relevance reasons
- [x] Script runs without MCP and produces quality prompt (graceful degradation)
- [x] All Python files are stdlib-only and under 200 LOC each
- [x] `python3 scripts/enhance-prompt.py "Fix auth bug" --intensity deep` works
- [x] `python3 scripts/enhance-prompt.py "Rename variable" --intensity light` produces minimal output

## Risk Assessment

| Risk | Mitigation |
|------|-----------|
| Over-scaffolding simple tasks | Intensity levels: light produces minimal prompt, avoids ceremony |
| Breaking existing behavior | Keep same CLI interface, --intensity is optional with auto-detection |
| Scripts exceeding 200 LOC | Split into 3 modules as planned |
| Prompt too long for context window | Token budget already exists; new blocks are short (~50 tokens each) |

## Completion Notes

All 9 implementation steps completed successfully on 2026-03-11:

1. **detect-intensity.py** (62 LOC) -- Light/standard/deep detection with word-boundary keyword matching to prevent false positives
2. **Prompt ordering restructured** -- Context blocks moved to top, objective/query moved to bottom per Anthropic best practices
3. **New blocks added** -- investigate_before_answering, grounding, anti_overengineering, use_parallel_tool_calls
4. **Verification strengthened** -- Changed to imperative self-check pattern ("Before you finish, verify...")
5. **enhance-prompt.py modularized** (190 LOC) -- Extracted detect-intensity.py (62 LOC) and prompt-blocks.py (97 LOC) for clarity
6. **context-injection-patterns.md updated** -- Document index pattern with relevance reasons for each code snippet
7. **task-type-strategies.md updated** -- Added intensity defaults per task type, parallel tool call guidance
8. **SKILL.md updated** -- Documented intensity levels, new blocks, prompt ordering, parallel tools
9. **Graceful degradation improved** -- Directs Claude to use built-in file tools (Read, Glob, Grep) when MCP unavailable

**Testing Results:** 23/23 tests passed. Code review: 0 critical issues, 3 high (all fixed), 5 medium (2 fixed).

**Key Fixes Applied:**
- H1: Empty prompt validation
- H2: Budget floor at 256 tokens minimum
- H3: Word-boundary regex to prevent false-positive keyword matches (e.g., "debate" matching "deep" keyword)
- M2: BUDGET_WEIGHTS aligned with TASK_MCP_TOOLS structure

**All success criteria met and verified.**

## Unresolved Questions

1. Should few-shot examples be bundled as files in `references/examples/` or generated dynamically? Recommend: static files per task type, loaded on demand via `--examples` flag. Defer to v2 if time-constrained -- intensity levels and prompt reordering deliver more value.
2. Should the `<document index="n">` pattern be enforced by the Python script (generating XML) or just documented as guidance for Claude to follow when injecting MCP results? Recommend: document as guidance since the script doesn't have actual MCP results at generation time.
