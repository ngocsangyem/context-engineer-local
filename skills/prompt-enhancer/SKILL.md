---
name: prompt-enhancer
description: >-
  Enrich user prompts with relevant codebase context from the MCP codebase index server.
  Automatically detects task type and intensity level, then injects ranked code snippets,
  repo maps, recent changes, and dependency graphs. Works best with MCP server; degrades
  gracefully to built-in file tools when unavailable.
argument-hint: "[prompt text or topic]"
---

# Prompt Enhancer

Enrich prompts with codebase context before execution. Uses MCP codebase index server
when available; falls back to built-in file tools (Read, Grep, Glob) when not.

## When to Activate

- User starts a coding, debugging, or review task in an indexed codebase
- User asks to "fix", "implement", "refactor", "debug", or "review" code
- User wants better context for their prompt

## Workflow

1. **Detect task type** from user prompt (coding, debug, review, refactor, research)
2. **Detect intensity** level (light, standard, deep) from prompt keywords and task type
3. **Select MCP tools** based on task type (see `references/task-type-strategies.md`)
4. **Query MCP server** using selected tools (parallel when inputs are independent)
5. **Rank and trim** results to fit token budget (default 4K tokens)
6. **Assemble enhanced prompt** — context at top, objective at bottom (per best practices)
7. **Execute** with enriched context

## Task-Type Detection

| Keywords | Task Type | Primary MCP Tools |
|----------|-----------|-------------------|
| fix, bug, error, crash, fail | debug | search_codebase, get_recent_changes, get_file_summary |
| implement, add, create, build | coding | search_codebase, get_dependencies |
| refactor, restructure, clean | refactor | get_dependencies, get_repo_map, search_codebase |
| review, audit, check | review | get_repo_map, get_file_summary |
| explain, understand, how | research | get_repo_map, search_codebase |

## Intensity Levels

| Level | Triggers | Blocks Included |
|-------|----------|-----------------|
| **light** | "quick", "simple", "trivial", "rename", "typo" | tool_rules, work_style, objective, done_criteria |
| **standard** | Default for most tasks | All light blocks + investigate, grounding, verification, parallel_tools, anti_overengineering (coding/refactor) |
| **deep** | "careful", "thorough", "critical", "production", "security" | All standard blocks with stronger verification |

## Prompt Ordering (Best Practices)

Enhanced prompts follow Anthropic's recommendation — longform context at top, query at bottom:

1. `<context_budget>` — token allocation for MCP results
2. `<tool_rules>` — which MCP tools to call and how
3. `<use_parallel_tool_calls>` — parallel execution (standard+, 2+ tools)
4. `<investigate_before_answering>` — prevent hallucination (standard+)
5. `<anti_overengineering>` — YAGNI/KISS (coding/refactor, standard+)
6. `<work_style>` — task-type specific approach
7. `<grounding>` — quote code before reasoning (standard+)
8. `<verification>` — imperative self-check (standard+)
9. `<objective>` — user's original prompt (BOTTOM)
10. `<done_criteria>` — when to stop

## Token Budget

- Default: 4096 tokens for injected context
- Allocation varies by task type (see `references/task-type-strategies.md`)
- Configurable via argument: `--budget 8192`

## Graceful Degradation

If MCP server is unavailable:
- Skip MCP-specific context injection (`<codebase_context>`, `<repo_structure>`, etc.)
- Keep all behavioral blocks (investigate, grounding, anti-overengineering, verification)
- Direct Claude to use built-in file tools (Read, Grep, Glob) for context
- Notice: "MCP codebase index not available — using file-system tools for context"

## Script Usage

```bash
python3 scripts/enhance-prompt.py "Fix the auth timeout bug"
python3 scripts/enhance-prompt.py "Fix the auth timeout bug" --intensity deep
python3 scripts/enhance-prompt.py "Rename variable" --intensity light --budget 2048
python3 scripts/enhance-prompt.py "Refactor auth module" --task refactor
```

## References

- [Context Injection Patterns](references/context-injection-patterns.md)
- [Task Type Strategies](references/task-type-strategies.md)
