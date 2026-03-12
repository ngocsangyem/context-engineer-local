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

**Step 0 — Check Indexing MCP availability (do this FIRST):**
Before running anything, check if MCP codebase-index tools are available to you (e.g., `search_codebase`, `get_file_summary`). If NO MCP tools are available, **skip this skill entirely** — proceed with the user's task using built-in file tools (Read, Grep, Glob) directly.

**Step 1 — Run the enhancement script:**
Find `enhance-prompt.py` in this skill's `scripts/` directory and run it:

```bash
python3 "SKILL_DIR/scripts/enhance-prompt.py" "USER_PROMPT_HERE"
```

Where `SKILL_DIR` is the absolute path to the directory containing this SKILL.md.

The script outputs an XML-structured enhanced prompt. **Use this output directly as your working instructions.** Do NOT rewrite or reformat it.

**Optional flags:** `--task TYPE`, `--intensity LEVEL`, `--budget N`, `--provider gemini|ollama|openai`

**Step 2 — Enrich with codebase context:**
1. Query MCP tools based on task type (see tables below)
2. Apply quality gates — fallback to file-tools if MCP results are poor
3. Inject specifics (file paths, line numbers) into the XML blocks
4. Execute with enriched context

## Task-Type Detection

| Keywords | Task Type | Primary MCP Tools |
|----------|-----------|-------------------|
| fix, bug, error, crash, fail | debug | search_codebase, get_recent_changes, get_file_summary |
| implement, add, create, build | coding | search_codebase, get_dependencies |
| refactor, restructure, clean | refactor | get_dependencies, get_repo_map, search_codebase |
| review, audit, check | review | get_repo_map, get_file_summary |
| explain, understand, how | research | get_repo_map, search_codebase |

**Framework-aware queries:** When the task targets a specific file, the file extension drives query strategy for the file-tool track. Vue/React/Svelte use `<ComponentName>` + import patterns; Python/Go/TS use symbol + import patterns. See `references/task-type-strategies.md` → "Framework-Aware Query Hints".

## Intensity Levels

| Level | Triggers | Blocks Included |
|-------|----------|-----------------|
| **light** | "quick", "simple", "trivial", "rename", "typo" | tool_rules, work_style, objective, done_criteria |
| **standard** | Default for most tasks | All light blocks + investigate, diagnosis, grounding, verification, parallel_tools, anti_overengineering (coding/refactor) |
| **deep** | "careful", "thorough", "critical", "production", "security" | All standard blocks with stronger verification |

## Prompt Ordering (Best Practices)

Enhanced prompts follow Anthropic's recommendation — longform context at top, query at bottom:

1. `<tool_rules>` — which MCP tools to call and how
2. `<use_parallel_tool_calls>` — parallel execution (standard+, 2+ tools)
3. `<investigate_before_answering>` — prevent hallucination (standard+)
4. `<diagnosis>` — analyze before acting: map responsibilities, find patterns (standard+)
5. `<anti_overengineering>` — YAGNI/KISS (coding/refactor, standard+)
6. `<work_style>` — task-type specific approach
7. `<grounding>` — quote code before reasoning (standard+)
8. `<verification>` — imperative self-check at meaningful checkpoints (standard+)
9. `<objective>` — narrative restatement with deliverable and success signal (BOTTOM)
10. `<done_criteria>` — when to stop

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
- Use "target ~200 lines for the script portion where reasonable" (excluding template/styles)
- Add: "avoid splitting cohesive logic solely to satisfy the line limit"
- A 220-line cohesive composable is better than 2 artificially split files
- For Vue SFCs: count template, script, style separately — a 180-line template + 150-line script is fine

## Token Budget

- Default: 4096 tokens for injected context
- Allocation varies by task type (see `references/task-type-strategies.md`)
- Configurable via argument: `--budget 8192`

## Graceful Degradation

### MCP Unavailable
If MCP server cannot be reached:
- Skip all MCP tool calls
- Keep all behavioral blocks (investigate, grounding, anti-overengineering, verification)
- Direct Claude to use built-in file tools (Read, Grep, Glob) for context
- Notice: "MCP codebase index not available — using file-system tools for context"

### Low-Quality Results
If MCP tools return but results are poor, apply quality gates before injecting context:

| Tool | Quality Gate | Fallback Action |
|------|-------------|-----------------|
| `search_codebase` | All results score <0.3, OR top result <0.5 | Re-query with literal Grep pattern instead |
| `get_file_summary` | Returns only file path, no symbols/outline | Use Read + manual outline extraction |
| `get_dependencies` | Both imports and imported-by are empty | Use Grep for import statements + component usage |
| `get_repo_map` | Empty or single-entry result | Use Glob for directory listing + file structure |

**Score behavior:**
- **<0.3**: Drop individual result (noise — never inject)
- **0.3–0.5**: Keep if at least one result scores ≥0.5 (marginal — useful as supporting context)
- **≥0.5**: Keep (good quality)
- If NO results score ≥0.5: tool fails quality gate → substitute with file-tool equivalent
- If 2+ tools fail quality gates: switch entire strategy to file-tools-only mode
- Notice: "MCP results below quality threshold for [tool] — supplementing with file-system tools"
- Keep all behavioral blocks regardless of degradation level

## Script Usage

```bash
python3 scripts/enhance-prompt.py "Fix the auth timeout bug"
python3 scripts/enhance-prompt.py "Fix the auth timeout bug" --intensity deep
python3 scripts/enhance-prompt.py "Rename variable" --intensity light --budget 2048
python3 scripts/enhance-prompt.py "Refactor auth module" --task refactor
python3 scripts/enhance-prompt.py "Fix auth bug" --provider gemini
python3 scripts/enhance-prompt.py "Refactor auth" --provider ollama --intensity deep
```

## External AI Provider (Optional)

Offload prompt improvement to an external AI instead of consuming Claude's context window.
The deterministic prompt is built first, then optionally refined by an external model.

### Provider Setup

| Variable | Default | Description |
|----------|---------|-------------|
| `PROMPT_ENHANCER_PROVIDER` | `none` | Provider: `gemini`, `ollama`, `openai`, or `none` |
| `GEMINI_API_KEY` | — | Google API key (shared across skills) |
| `GEMINI_MODEL` | `gemini-2.5-flash` | Gemini model name |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama server URL |
| `OLLAMA_MODEL` | `llama3.2` | Ollama model name |
| `OPENAI_API_KEY` | — | OpenAI or compatible API key |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | OpenAI-compatible base URL |
| `OPENAI_MODEL` | `gpt-4o-mini` | Model name |

### Configuration

**Claude Code** (`.mcp.json`):
```json
{
  "mcpServers": {
    "codebase-index": {
      "command": "node",
      "args": ["path/to/mcp-codebase-index/dist/index.js", "--path", "/your/repo"],
      "env": {
        "PROMPT_ENHANCER_PROVIDER": "gemini",
        "GEMINI_API_KEY": "your-key-here"
      }
    }
  }
}
```

**Cursor** (`~/.cursor/mcp.json`) — same JSON format as Claude Code.

**Windsurf** (`~/.codeium/windsurf/mcp_config.json`) — same JSON format.

**Via .env file** (either location works):
```bash
# Option 1: Inside .claude/ (standard hierarchy)
# .claude/skills/prompt-enhancer/.env

# Option 2: Next to the skill (auto-detected fallback)
# skills/prompt-enhancer/.env

PROMPT_ENHANCER_PROVIDER=gemini
GEMINI_API_KEY=your-key-here
```

**Ollama (local)**:
```bash
ollama pull llama3.2
# .claude/skills/prompt-enhancer/.env
PROMPT_ENHANCER_PROVIDER=ollama
OLLAMA_MODEL=llama3.2
```

**OpenAI-compatible** (vLLM, LM Studio, Groq, Together):
```bash
# .claude/skills/prompt-enhancer/.env
PROMPT_ENHANCER_PROVIDER=openai
OPENAI_BASE_URL=http://localhost:1234/v1   # LM Studio
OPENAI_API_KEY=lm-studio                    # LM Studio uses any string
OPENAI_MODEL=your-local-model
```

### Fallback Behavior

1. External AI succeeds → return AI-improved prompt
2. API key missing → return deterministic prompt + stderr notice
3. API call fails (timeout/error) → return deterministic prompt + stderr notice
4. AI response fails validation → return deterministic prompt + stderr notice

The enhancement pipeline never fails — it always returns a usable prompt.

### Standalone Testing

```bash
python3 scripts/external-ai-enhance.py "Test prompt" --provider gemini
python3 scripts/external-ai-enhance.py "Test prompt" --provider ollama
```

## References

- [Context Injection Patterns](references/context-injection-patterns.md)
- [Task Type Strategies](references/task-type-strategies.md)
