#!/usr/bin/env python3
"""
prompt-blocks.py — XML block builders for enhanced prompts.

Generates conditional prompt blocks based on task type and intensity level.
Blocks follow Anthropic's Claude Code best practices: investigate before
answering, ground responses in code, avoid overengineering, use parallel tools.

No external dependencies — stdlib only.
"""

from __future__ import annotations

import re


def build_investigate_block() -> str:
    """Block that prevents hallucination about unread code. Standard+ intensity."""
    return (
        "<investigate_before_answering>\n"
        "Never speculate about code you have not opened. If the user references a\n"
        "specific file, read the file before answering. Investigate relevant files\n"
        "BEFORE answering questions about the codebase. Give grounded,\n"
        "hallucination-free answers.\n"
        "Match investigation scope to verification scope — if you plan to verify N\n"
        "consumers, investigate a representative sample of those same consumers.\n"
        "</investigate_before_answering>"
    )


def build_grounding_block() -> str:
    """Block that tells Claude to quote code before reasoning. Standard+ intensity."""
    return (
        "<grounding>\n"
        "When using injected codebase context, quote the relevant code snippets or\n"
        "symbols before reasoning about them. This grounds your answer in the actual\n"
        "code rather than assumptions.\n"
        "</grounding>"
    )


def build_anti_overengineering_block() -> str:
    """YAGNI/KISS block for coding/refactor tasks. Standard+ intensity."""
    return (
        "<anti_overengineering>\n"
        "Apply YAGNI: implement only what is needed now, not what might be needed later.\n"
        "Prefer the simplest solution that satisfies the requirements.\n"
        "Do not add abstractions, interfaces, or layers unless they solve a concrete\n"
        "current problem. Do not hard-code values just to pass tests — implement\n"
        "general solutions.\n"
        "</anti_overengineering>"
    )


def build_parallel_tools_block() -> str:
    """Block enabling parallel MCP tool calls. Included when 2+ independent tools."""
    return (
        "<use_parallel_tool_calls>\n"
        "When multiple MCP tools need to be called and their inputs are independent,\n"
        "call them in parallel rather than sequentially for faster context retrieval.\n"
        "</use_parallel_tool_calls>"
    )


_DIAGNOSIS_TEMPLATES: dict[str, str] = {
    "debug": (
        "Before proposing a fix, diagnose:\n"
        "- Map the error propagation path from symptom to root cause.\n"
        "- Determine whether the defect is in this file or upstream.\n"
        "- Check if recent changes introduced a regression.\n"
        "Document your diagnosis before proposing changes."
    ),
    "coding": (
        "Before writing new code, diagnose:\n"
        "- Map existing patterns for this feature type in the codebase.\n"
        "- Identify integration points and potential conflicts.\n"
        "- Assess whether existing utilities already cover part of the need.\n"
        "Document your diagnosis before proposing changes."
    ),
    "refactor": (
        "Before extracting or restructuring, diagnose:\n"
        "- Map all responsibilities in the target file.\n"
        "- Identify natural boundaries between concerns (e.g., UI orchestration, "
        "state bridging, data fetching, action handlers).\n"
        "- Identify duplicated patterns and DRY violation candidates.\n"
        "- Assess which boundaries are natural extraction points vs artificial splits.\n"
        "Document your diagnosis before proposing changes."
    ),
    "review": (
        "Before critiquing, diagnose:\n"
        "- Map the module's architecture and conventions.\n"
        "- Identify which patterns are intentional conventions vs accidental complexity.\n"
        "- Note areas where the code diverges from project standards.\n"
        "Document your diagnosis before listing findings."
    ),
    "research": (
        "Before explaining, diagnose:\n"
        "- Map the system's structure and key relationships.\n"
        "- Identify which parts are stable vs actively changing.\n"
        "- Find concrete examples that illustrate the concepts.\n"
        "Document your diagnosis before explaining."
    ),
}


def build_diagnosis_block(task: str) -> str:
    """Analysis-before-action block. Forces 'thinking before doing'. Standard+ intensity."""
    content = _DIAGNOSIS_TEMPLATES.get(task, _DIAGNOSIS_TEMPLATES["research"])
    return f"<diagnosis>\n{content}\n</diagnosis>"


# Universal multi-word phrases — always safe to strip regardless of task type.
_UNIVERSAL_PHRASES: list[str] = sorted([
    "analyze and improve", "analyze and fix", "help me improve", "help me fix",
    "analyze", "improve", "update", "migrate", "optimize",
], key=len, reverse=True)

# Task-specific verbs that are semantically equivalent to the template's lead verb.
# Only these get stripped; others (e.g., "rename" for refactor) carry specific intent.
_SAFE_TASK_VERBS: dict[str, list[str]] = {
    "debug":    ["fix", "debug", "resolve", "diagnose", "troubleshoot"],
    "coding":   ["implement", "add", "create", "build", "write", "develop"],
    "refactor": ["refactor", "restructure", "reorganize"],
    "review":   ["review", "audit", "inspect", "evaluate", "assess", "critique"],
    "research": ["explain", "explore", "research", "investigate", "describe"],
}


def _extract_subject(prompt: str, task: str) -> tuple[str, bool]:
    """Strip leading verb from prompt to isolate the subject.

    Two-pass approach:
    1. Try universal multi-word phrases (always strip)
    2. Try task-safe verbs (only verbs the template naturally replaces)

    Returns (subject, was_stripped). When was_stripped=False, the original verb
    carries specific intent and should not be overridden by a template verb.
    """
    lowered = prompt.lower()

    # Pass 1: universal phrases (safe to strip for any task type)
    for phrase in _UNIVERSAL_PHRASES:
        pattern = r'^' + re.escape(phrase) + r'\s+'
        if re.match(pattern, lowered):
            subject = prompt[len(phrase):].strip()
            if subject:
                return subject, True

    # Pass 2: task-safe verbs only
    safe_verbs = sorted(_SAFE_TASK_VERBS.get(task, []), key=len, reverse=True)
    for verb in safe_verbs:
        pattern = r'^' + re.escape(verb) + r'\s+'
        if re.match(pattern, lowered):
            subject = prompt[len(verb):].strip()
            if subject:
                return subject, True

    return prompt, False


# --- Narrative objective templates (used when verb was safely stripped) ---
_NARRATIVE_TEMPLATES: dict[str, str] = {
    "debug": (
        "Identify and fix the root cause of {subject}. "
        "The deliverable is a minimal, correct code change that resolves the defect "
        "without breaking existing functionality. "
        "Success: the issue is resolved and all existing tests pass."
    ),
    "coding": (
        "Implement {subject}. "
        "The deliverable is working, production-ready code that integrates cleanly "
        "with the existing codebase. "
        "Success: the feature works correctly, handles edge cases, and follows project conventions."
    ),
    "refactor": (
        "Refactor {subject}. "
        "The deliverable is cleaner code with identical external behavior. "
        "Success: all call sites updated, tests pass, and the public API contract is preserved."
    ),
    "review": (
        "Review and assess {subject}. "
        "The deliverable is a findings report organized by severity with actionable next steps. "
        "Success: all issues are documented, grounded in actual code, and prioritized."
    ),
    "research": (
        "Analyze and explain {subject}. "
        "The deliverable is a clear, grounded explanation backed by codebase evidence. "
        "Success: key concepts covered with specific file/symbol citations."
    ),
}

# --- Deliverable suffixes (used when original verb carries specific intent) ---
_DELIVERABLE_SUFFIXES: dict[str, str] = {
    "debug": "The deliverable is a minimal, correct code change. Success: issue resolved, tests pass.",
    "coding": "The deliverable is working, production-ready code. Success: integrates cleanly, handles edge cases.",
    "refactor": "The deliverable is cleaner code with identical external behavior. Success: tests pass, API preserved.",
    "review": "The deliverable is a findings report by severity. Success: all issues documented with next steps.",
    "research": "The deliverable is a grounded explanation. Success: key concepts covered with citations.",
}

_VERIFY_FROM_SOURCE = (
    "Verify all observations against the actual codebase before acting: "
    "line counts (wc -l), consumer counts (grep/import scan), "
    "props/emits (read source). Use ~approximate numbers until confirmed."
)


def build_narrative_objective(task: str, raw_prompt: str) -> str:
    """Build a clean narrative objective from raw prompt and detected task type.

    Two-tier approach:
    - If verb was safely stripped: use full template (action + deliverable + success)
    - If verb carries specific intent: keep original prompt + append deliverable suffix
    Appends "verify from source" directive and preserves original prompt.
    """
    subject, was_stripped = _extract_subject(raw_prompt, task)

    if was_stripped:
        template = _NARRATIVE_TEMPLATES.get(task, _NARRATIVE_TEMPLATES["research"])
        narrative = template.format(subject=subject)
    else:
        suffix = _DELIVERABLE_SUFFIXES.get(task, _DELIVERABLE_SUFFIXES["research"])
        narrative = f"{raw_prompt}. {suffix}"

    return f"{narrative}\n{_VERIFY_FROM_SOURCE}\nOriginal request: {raw_prompt}"


def build_verification(task: str) -> str:
    """Imperative self-check verification pattern per task type.

    Uses realistic cadence ("at meaningful checkpoints") and scoped language
    ("where feasible") instead of absolute claims.
    """
    checks: dict[str, list[str]] = {
        "debug": [
            "The fix addresses the root cause, not just the symptom.",
            "Related call sites do not have the same bug.",
            "No existing tests regress.",
        ],
        "coding": [
            "The implementation compiles and integrates with existing code.",
            "Edge cases and error paths are handled.",
            "Naming and style match the surrounding codebase.",
        ],
        "refactor": [
            "Verify no consumer-facing API changes; use grep/import scan where feasible.",
            "The test suite passes.",
            "The public API contract is preserved (or changes are documented).",
        ],
        "review": [
            "Each finding is grounded in actual code, not assumptions.",
            "High-severity issues are distinguished from style preferences.",
            "Each finding includes a suggested next step.",
        ],
        "research": [
            "The explanation is accurate against the actual codebase.",
            "Specific files or symbols are cited to support each claim.",
        ],
    }
    task_checks = checks.get(task, checks["research"])
    numbered = "\n".join(f"  {i}. {c}" for i, c in enumerate(task_checks, 1))
    n = len(task_checks) + 1
    return (
        f"At meaningful checkpoints (not after every micro-change), verify:\n"
        f"{numbered}\n"
        f"  {n}. Your answer is grounded in actual code, not assumptions.\n"
        f"  {n+1}. No existing functionality is broken by your changes.\n"
        f"If full verification isn't possible, document assumptions explicitly."
    )
