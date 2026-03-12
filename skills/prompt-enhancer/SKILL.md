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
6. **Assemble enhanced prompt** — context at top, narrative objective at bottom (action verb, deliverable, scope, success signal)
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
| **standard** | Default for most tasks | All light blocks + investigate, diagnosis, grounding, verification, parallel_tools, anti_overengineering (coding/refactor) |
| **deep** | "careful", "thorough", "critical", "production", "security" | All standard blocks with stronger verification |

## Prompt Ordering (Best Practices)

Enhanced prompts follow Anthropic's recommendation — longform context at top, query at bottom:

1. `<context_budget>` — token allocation for MCP results
2. `<tool_rules>` — which MCP tools to call and how
3. `<use_parallel_tool_calls>` — parallel execution (standard+, 2+ tools)
4. `<investigate_before_answering>` — prevent hallucination (standard+)
5. `<diagnosis>` — analyze before acting: map responsibilities, find patterns (standard+)
6. `<anti_overengineering>` — YAGNI/KISS (coding/refactor, standard+)
7. `<work_style>` — task-type specific approach
8. `<grounding>` — quote code before reasoning (standard+)
9. `<verification>` — imperative self-check at meaningful checkpoints (standard+)
10. `<objective>` — narrative restatement with deliverable and success signal (BOTTOM)
11. `<done_criteria>` — when to stop

## Narrative Objective Format

**CRITICAL:** The `<objective>` is ONE block within the full XML-structured prompt. ALL other blocks (context_budget, tool_rules, investigate, grounding, verification, work_style, done_criteria, etc.) MUST still be present. Never replace the full XML structure with just a narrative.

The `<objective>` block must restate the user's task as a structured narrative — not echo the raw prompt. Structure:

1. **Action statement** — Lead with a specific verb matching the task type (fix, implement, refactor, review, analyze)
2. **Context** — Key facts discovered from codebase analysis (file size, consumer count, architecture details)
3. **Constraints** — What must be preserved, what's out of scope
4. **Deliverables** — What artifacts to produce
5. **Approach** — High-level strategy (optional, for complex tasks)

Keep under 4 sections for simple tasks. Use all 5 for complex/deep-intensity tasks.

**Example (refactor task):**
```xml
<objective>
Refactor customer-frontend/src/components/common/filters/AspireFilter.vue (~688 lines) to comply with the project's 200-line file size guideline.

Context:
- Component used in ~49 consumer files across transactions, cards, bills, accounting features
- Dual architecture: legacy state + unified state behind isUnifiedStateEnabled feature flag
- 20+ props, 4 emits, 2 slots define the public API

Constraints:
- Preserve exact public API (props, emits, slots) — zero changes to consumers
- Preserve legacy/unified dual-path unless feature flag status confirmed
- Follow YAGNI/KISS/DRY — extract, don't abstract

Deliverables:
1. Prioritized list of extractions with specific line-range references
2. Proposed file names and locations for each extraction
3. Risk assessment for each extraction

Verify all observations against the actual codebase before acting — use ~approximate numbers until confirmed.
Original request: Analyze and improve AspireFilter.vue
</objective>
```

## Generation Guidelines

When assembling enhanced prompts with codebase-specific context:

### Use Approximate Language for Observations
- Prefix counts with "~" (e.g., "~45 consumer files", "~687 lines")
- Add "verify against the codebase before acting" after factual claims
- Distinguish known facts from observations that need confirmation

### Approach Section: Candidates, Not Commands
- Use "consider extracting..." not "extract..."
- Add qualifier: "if supported by the code" or "if self-contained"
- Frame as candidate targets the agent should evaluate, not steps to follow blindly

### Match Investigation and Verification Scope
- If verification claims "all N consumers unchanged," investigation must scan those consumers
- If investigation only samples 2-3, verification should say "verify no API changes; scan consumers where feasible"
- Never promise verification you can't deliver

### Realistic Verification Cadence
- Use "at meaningful checkpoints" not "after each step"
- Compile/typecheck after major extractions, not after every micro-change
- "If full verification isn't possible, document assumptions explicitly"

### File Size Targets: Flexible, Not Rigid
- Use "target under 200 lines where reasonable"
- Add: "avoid splitting cohesive logic solely to satisfy the line limit"
- A 220-line cohesive composable is better than 2 artificially split files

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
