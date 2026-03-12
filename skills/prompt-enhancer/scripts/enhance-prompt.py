#!/usr/bin/env python3
"""
enhance-prompt.py — Deterministic prompt enhancement for the prompt-enhancer skill.

Accepts a raw prompt, detects task type and intensity, and outputs a structured
enhanced prompt following Anthropic's best practices: codebase context at top,
objective/query at bottom, with conditional blocks based on intensity level.

No external dependencies — stdlib only.
"""

from __future__ import annotations

import argparse
import importlib.util
import os
import re
import sys
from textwrap import dedent

# ---------------------------------------------------------------------------
# Import sibling modules from the same scripts/ directory.
# ---------------------------------------------------------------------------
_scripts_dir = os.path.dirname(os.path.abspath(__file__))


def _import_module(filename: str, module_name: str):
    """Import a sibling module by filename (handles kebab-case names)."""
    spec = importlib.util.spec_from_file_location(module_name, os.path.join(_scripts_dir, filename))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


_intensity_mod = _import_module("detect-intensity.py", "detect_intensity")
_blocks_mod = _import_module("prompt-blocks.py", "prompt_blocks")

detect_intensity = _intensity_mod.detect_intensity
build_investigate_block = _blocks_mod.build_investigate_block
build_grounding_block = _blocks_mod.build_grounding_block
build_anti_overengineering_block = _blocks_mod.build_anti_overengineering_block
build_parallel_tools_block = _blocks_mod.build_parallel_tools_block
build_verification = _blocks_mod.build_verification
build_narrative_objective = _blocks_mod.build_narrative_objective
build_diagnosis_block = _blocks_mod.build_diagnosis_block

# ---------------------------------------------------------------------------
# Task type detection and constants
# ---------------------------------------------------------------------------

TASK_KEYWORDS: dict[str, list[str]] = {
    "debug":    ["fix", "bug", "error", "crash", "fail", "broken", "exception", "traceback", "issue"],
    "coding":   ["implement", "add", "create", "build", "write", "develop", "feature"],
    "refactor": ["refactor", "restructure", "clean", "reorganize", "simplify", "extract", "rename"],
    "review":   ["review", "audit", "check", "inspect", "evaluate", "assess", "critique"],
    "research": ["explain", "understand", "how", "what", "why", "explore", "research", "investigate"],
}

TASK_MCP_TOOLS: dict[str, list[str]] = {
    "debug":    ["search_codebase", "get_recent_changes", "get_file_summary"],
    "coding":   ["search_codebase", "get_dependencies"],
    "refactor": ["get_dependencies", "get_repo_map", "search_codebase"],
    "review":   ["get_repo_map", "get_file_summary"],
    "research": ["get_repo_map", "search_codebase"],
}

BUDGET_WEIGHTS: dict[str, dict[str, float]] = {
    "debug":    {"search_codebase": 0.50, "get_recent_changes": 0.30, "get_file_summary": 0.20},
    "coding":   {"search_codebase": 0.70, "get_dependencies": 0.30},
    "refactor": {"get_dependencies": 0.40, "get_repo_map": 0.30, "search_codebase": 0.30},
    "review":   {"get_repo_map": 0.60, "get_file_summary": 0.40},
    "research": {"get_repo_map": 0.50, "search_codebase": 0.50},
}

CONTEXT_FOCUS: dict[str, str] = {
    "debug":    "error-related code paths, recent diffs, and the file containing the defect",
    "coding":   "similar existing implementations and the import graph of the target module",
    "refactor": "full dependency graph, all callers of the target symbol, and affected file list",
    "review":   "architecture overview, key exported symbols, and file-level outlines",
    "research": "codebase-wide conventions, representative patterns, and structural overview",
}

WORK_STYLE: dict[str, str] = {
    "debug":    "Locate the defect before proposing a fix. Check recent changes for regressions, then implement the minimal correct change.",
    "coding":   "Study existing patterns before writing new code. Match the style of the surrounding codebase. Validate the new code compiles and integrates cleanly.",
    "refactor": "Map all callers and dependents before restructuring. Prefer small, incremental changes. Confirm the public API contract is preserved.",
    "review":   "Read with fresh eyes. Distinguish confirmed defects from plausible risks. Group findings by severity.",
    "research": "Build a structural understanding before explaining. Find concrete examples in the codebase to ground the explanation.",
}


def detect_task(prompt: str) -> str:
    """Score each task type by word-boundary keyword hits and return the best match."""
    lowered = prompt.lower()
    scores = {t: sum(1 for kw in kws if re.search(r'\b' + re.escape(kw) + r'\b', lowered)) for t, kws in TASK_KEYWORDS.items()}
    best, score = max(scores.items(), key=lambda x: x[1])
    return best if score > 0 else "research"


def _build_budget(task: str, budget: int) -> str:
    weights = BUDGET_WEIGHTS[task]
    lines = [f"Total context budget: {budget} tokens", "Allocation:"]
    for tool, w in weights.items():
        lines.append(f"  - {tool}: {int(budget * w)} tokens ({int(w * 100)}%)")
    return "\n".join(lines)


def _build_tool_rules(task: str, prompt: str, intensity: str) -> str:
    tools = TASK_MCP_TOOLS[task]
    query_hint = re.sub(r"\s+", " ", prompt).strip()[:60]
    lines = [
        f"Query the MCP codebase index server before generating code or explanations.",
        f"Primary tool: {tools[0]}(query=\"{query_hint}\")",
    ]
    if len(tools) > 1:
        lines.append(f"Secondary tools: {', '.join(tools[1:])}")
    lines.append(f"Context focus: {CONTEXT_FOCUS[task]}")
    lines.append("If MCP server is unavailable: use built-in file tools (Read, Grep, Glob) for context instead.")
    return "\n".join(lines)


def enhance(raw_prompt: str, task: str | None, budget: int, intensity: str | None) -> str:
    """Build the enhanced prompt: context-first, query-last per best practices."""
    normalized = re.sub(r"\s+", " ", raw_prompt).strip()
    if not normalized:
        return "Error: empty prompt. Provide a task description to enhance."
    budget = max(budget, 256)  # Floor at 256 tokens to avoid nonsensical allocations.
    detected_task = task or detect_task(normalized)
    detected_intensity = intensity or detect_intensity(normalized, detected_task)
    is_standard_plus = detected_intensity in ("standard", "deep")
    tools = TASK_MCP_TOOLS[detected_task]
    has_parallel = len(tools) >= 2

    sections: list[str] = []

    # --- TOP: Context directives (longform data at top per best practices) ---
    sections.append(f"<context_budget>\n{_build_budget(detected_task, budget)}\nTrim lower-relevance results first when over budget.\n</context_budget>")
    sections.append(f"<tool_rules>\n{_build_tool_rules(detected_task, normalized, detected_intensity)}\n</tool_rules>")

    if has_parallel and is_standard_plus:
        sections.append(build_parallel_tools_block())

    # --- MIDDLE: Behavioral blocks (conditional on intensity) ---
    if is_standard_plus:
        sections.append(build_investigate_block())

    # --- Diagnosis: think before doing (standard+ only) ---
    if is_standard_plus:
        sections.append(build_diagnosis_block(detected_task))

    if is_standard_plus and detected_task in ("coding", "refactor"):
        sections.append(build_anti_overengineering_block())

    sections.append(f"<work_style>\nTask type: {detected_task} | Intensity: {detected_intensity}\n{WORK_STYLE[detected_task]}\nUse first-principles reasoning before proposing changes.\n</work_style>")

    if is_standard_plus:
        sections.append(build_grounding_block())

    # --- Verification (light skips this) ---
    if is_standard_plus:
        sections.append(f"<verification>\n{build_verification(detected_task)}\n</verification>")

    # --- BOTTOM: Objective/query last (up to 30% quality improvement) ---
    sections.append(f"<objective>\n{build_narrative_objective(detected_task, normalized)}\n</objective>")
    sections.append(f"<done_criteria>\n{_done_criteria(detected_task)}\nStop only when the response satisfies the task and passes verification.\n</done_criteria>")

    return "\n\n".join(sections)


def _done_criteria(task: str) -> str:
    m = {
        "debug": "The bug is identified, the fix is implemented, and no tests regress.",
        "coding": "The feature is implemented, integrates cleanly, and handles error cases.",
        "refactor": "All affected files are updated, tests pass, and the public API contract is maintained.",
        "review": "All findings are documented by severity with a suggested next step for each.",
        "research": "The explanation is grounded in real codebase evidence and covers the key concepts.",
    }
    return m.get(task, m["research"])


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(description="Enhance a raw prompt with MCP codebase context directives.")
    parser.add_argument("prompt", help="Raw prompt text to enhance.")
    parser.add_argument("--task", choices=sorted(TASK_KEYWORDS.keys()), default=None, help="Override task-type detection.")
    parser.add_argument("--budget", type=int, default=4096, help="Token budget for injected context (default: 4096).")
    parser.add_argument("--intensity", choices=["light", "standard", "deep"], default=None, help="Override intensity detection.")
    args = parser.parse_args()
    print(enhance(args.prompt, args.task, args.budget, args.intensity))


if __name__ == "__main__":
    main()
