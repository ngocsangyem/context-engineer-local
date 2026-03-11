# Code Review: prompt-enhancer Skill

## Scope
- Files: 6 (3 Python scripts, SKILL.md, 2 reference docs)
- LOC: ~745 total (345 code, 400 docs)
- Focus: full skill review

## Overall Assessment

Clean, well-structured skill. Good separation of concerns across 3 modules, all under 200 LOC. The prompt output follows Anthropic best practices (context-first, query-last, XML tags). No external dependencies. Several edge-case bugs and doc inconsistencies found.

---

## Critical Issues

None.

---

## High Priority

### H1. Empty prompt produces malformed output
**File:** `scripts/enhance-prompt.py` line 155
**Bug:** Empty string input produces `<objective>\n\nOptimize for...` with blank objective. The `query_hint` in tool_rules becomes `search_codebase(query="")` which is useless.
**Fix:** Validate prompt non-empty in `main()`:
```python
if not args.prompt.strip():
    parser.error("Prompt cannot be empty.")
```

### H2. Negative/zero budget produces nonsensical output
**File:** `scripts/enhance-prompt.py` line 98-103
**Bug:** `--budget -100` outputs negative token allocations like `-50 tokens (50%)`. Zero budget is equally pointless.
**Fix:** Add validation in `main()`:
```python
if args.budget < 1:
    parser.error("Budget must be a positive integer.")
```

### H3. Substring false-positive in keyword matching
**File:** `scripts/detect-intensity.py` lines 46, 50; `scripts/enhance-prompt.py` line 93
**Bug:** `kw in lowered` does substring matching. "how" matches "show", "somehow". "simple" matches "simpleton". "fail" matches "tail" (unlikely but illustrates the pattern). "check" matches "checkout". "clean" matches "cleanup" (actually desirable, but "how" matching inside words is not).
**Impact:** Task and intensity misclassification for certain prompts.
**Fix:** Use word-boundary regex for short keywords (<=4 chars) or all keywords:
```python
import re
if any(re.search(rf"\b{re.escape(kw)}\b", lowered) for kw in DEEP_KEYWORDS):
```
Performance cost is negligible for these small keyword lists.

### H4. "security audit" detected as "review" not "debug"
**File:** `scripts/enhance-prompt.py` lines 49-55
**Bug:** "careful security audit of the auth module" detects as "review" (keyword "audit") with deep intensity. The word "security" is a deep-intensity keyword in detect-intensity.py but not a task keyword. This is arguably correct behavior, but the SKILL.md table lists "security" as triggering "deep" intensity, not a specific task type. The interaction is fine but worth documenting that task and intensity are orthogonal.

---

## Medium Priority

### M1. Budget split in docs vs code inconsistency
**File:** `references/task-type-strategies.md` lines 26-28 vs `scripts/enhance-prompt.py` lines 65-71
**Bug:** The reference doc states debug budget: `2048/1229/819` but code uses weights `0.50/0.30/0.20` producing `2048/1228/819` (1228 vs 1229 due to `int()` truncation). Similarly coding doc says `2458/1229/409` but code weights `0.60/0.30` would give `2457/1228` for a two-tool split, and the doc mentions a third tool (`get_repo_map` at 409 tokens) that is NOT in `TASK_MCP_TOOLS["coding"]`.
**Fix:** Align reference doc numbers with actual `int(budget * weight)` outputs. Remove `get_repo_map` from coding budget docs or add it to `TASK_MCP_TOOLS["coding"]`.

### M2. `_build_budget` inconsistent with `TASK_MCP_TOOLS`
**File:** `scripts/enhance-prompt.py` lines 57-71, 98-103
**Bug:** `_build_budget` uses `BUDGET_WEIGHTS[task]` which has different tool sets than `TASK_MCP_TOOLS[task]`. For "coding", BUDGET_WEIGHTS includes `get_repo_map` at 0.10 but TASK_MCP_TOOLS does not list it. For "review", BUDGET_WEIGHTS includes `search_codebase` at 0.10 but TASK_MCP_TOOLS does not list it. Budget displays tools that are not in the tool rules section.
**Fix:** Ensure BUDGET_WEIGHTS keys match TASK_MCP_TOOLS entries per task, or add the missing tools to TASK_MCP_TOOLS.

### M3. `importlib.util` import — no error handling for missing files
**File:** `scripts/enhance-prompt.py` lines 27-36
**Bug:** If `detect-intensity.py` or `prompt-blocks.py` is missing/renamed, `spec_from_file_location` returns `None` and `module_from_spec(None)` throws a confusing `AttributeError`.
**Fix:**
```python
def _import_module(filename: str, module_name: str):
    path = os.path.join(_scripts_dir, filename)
    spec = importlib.util.spec_from_file_location(module_name, path)
    if spec is None or spec.loader is None:
        raise ImportError(f"Cannot load {filename} from {path}")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod
```

### M4. Verification block has redundant check
**File:** `scripts/prompt-blocks.py` lines 89-96
**Observation:** The generic checks appended at lines 95-96 ("grounded in actual code", "no existing functionality broken") overlap with task-specific checks. For "review" task, check 1 says "grounded in actual code, not assumptions" and the generic check 4 says the same. Minor noise.
**Fix:** Deduplicate or remove generic "grounded" check when task checks already include it.

### M5. No `__init__.py` — `scripts/` not a proper package
**File:** `scripts/` directory
**Observation:** Using `importlib.util` is the correct workaround for kebab-case filenames (Python identifiers cannot contain hyphens). This is robust. However, the approach means these modules cannot be tested independently with standard `import`. Consider adding an `__init__.py` for discoverability even if it does not import the kebab-case modules.

---

## Low Priority

### L1. `query_hint` truncation at 60 chars without word boundary
**File:** `scripts/enhance-prompt.py` line 108
**Observation:** `query_hint = re.sub(r"\s+", " ", prompt).strip()[:60]` can cut mid-word. Minor aesthetic issue in the generated tool_rules section.

### L2. SKILL.md "Before/After" example in context-injection-patterns.md is incomplete
**File:** `references/context-injection-patterns.md` lines 157-188
**Observation:** The "After (enhanced - deep intensity)" example is missing blocks that the code actually produces for deep intensity (grounding, work_style, done_criteria). It is a simplified illustration but could confuse users expecting exact output.

### L3. Task detection tie-breaking is deterministic but arbitrary
**File:** `scripts/enhance-prompt.py` line 94
**Observation:** `max(scores.items(), key=lambda x: x[1])` breaks ties by dict insertion order. For "fix and explain the bug" (debug:2, research:1), debug wins correctly. But equal-score ties depend on dict order. Acceptable for current keyword sets but worth a comment.

---

## Edge Cases Found

| Scenario | Behavior | Verdict |
|----------|----------|---------|
| Empty prompt `""` | Falls through to research/light, outputs blank objective | **Bug** (H1) |
| Negative budget `--budget -100` | Outputs negative token counts | **Bug** (H2) |
| "show me how checkout works" | "how" matches research, "check" matches review | **Potential misclassification** (H3) |
| Very long prompt (>200 chars) with light keywords | Light keywords win over length bump | **Correct** (keywords > length) |
| Unknown `--task` value | argparse rejects with choices validation | **Correct** |
| Unicode/emoji in prompt | Works fine, keyword matching on lowered ascii subset | **OK** |
| Prompt with only whitespace `"   "` | Normalizes to empty, same as H1 | **Bug** |

---

## Positive Observations

- All files under 200 LOC, clean separation: detection / blocks / orchestrator
- No external dependencies, stdlib-only
- Follows Anthropic best practices: context-first, query-last ordering
- XML tags are well-chosen and semantically meaningful
- Intensity system (light/standard/deep) is a smart design — avoids over-scaffolding trivial tasks
- CLI is clean with proper argparse usage and sensible defaults
- Graceful degradation strategy is well-documented
- The `importlib.util` approach for kebab-case filenames is the right choice

---

## Recommended Actions

1. **[H1+H2]** Add input validation for empty prompt and non-positive budget in `main()`
2. **[H3]** Switch to word-boundary regex matching for keyword detection
3. **[M1+M2]** Reconcile BUDGET_WEIGHTS and TASK_MCP_TOOLS — ensure both dictionaries agree on which tools each task uses; update reference docs to match
4. **[M3]** Add null-check in `_import_module` for clearer error messages
5. **[M4]** Deduplicate the "grounded in actual code" verification check

---

## Metrics

- Type Coverage: N/A (Python, no mypy annotations beyond basic hints; type hints present on public functions)
- Test Coverage: 0% (no tests exist)
- Linting Issues: 0 (stdlib-only, clean syntax)
- LOC compliance: All files under 200 LOC

---

## Unresolved Questions

1. Should the skill include unit tests? The logic in `detect_intensity` and `detect_task` is testable and keyword lists will likely grow. Tests would prevent regression.
2. Is the `coding` task intentionally missing `get_repo_map` from TASK_MCP_TOOLS but including it in BUDGET_WEIGHTS? If intentional, the budget display is misleading.
3. Should keyword matching use word boundaries or is substring matching an intentional design choice for broader recall?
