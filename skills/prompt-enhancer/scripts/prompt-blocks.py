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


def _extract_subject(prompt: str, task: str) -> str:
    """Strip leading task verb from prompt to isolate the subject.

    Example: "Fix the auth timeout bug" → "the auth timeout bug"
    """
    # Map task types to verbs commonly leading their prompts.
    _TASK_VERBS: dict[str, list[str]] = {
        "debug":    ["fix", "debug", "resolve", "diagnose", "troubleshoot"],
        "coding":   ["implement", "add", "create", "build", "write", "develop"],
        "refactor": ["refactor", "restructure", "clean up", "reorganize", "simplify", "extract", "rename"],
        "review":   ["review", "audit", "check", "inspect", "evaluate", "assess", "critique"],
        "research": ["explain", "understand", "explore", "research", "investigate", "describe"],
    }

    verbs = _TASK_VERBS.get(task, [])
    lowered = prompt.lower()
    for verb in sorted(verbs, key=len, reverse=True):  # longest first
        pattern = r'^' + re.escape(verb) + r'\s+'
        if re.match(pattern, lowered):
            subject = prompt[len(verb):].strip()
            return subject if subject else prompt  # Guard: verb-only → use full prompt
    return prompt


# --- Narrative objective templates per task type ---
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


def build_narrative_objective(task: str, raw_prompt: str) -> str:
    """Build a clean narrative objective from raw prompt and detected task type.

    Produces 2-4 sentences: action verb, deliverable, scope hint, success signal.
    Preserves original prompt as reference.
    """
    subject = _extract_subject(raw_prompt, task)
    template = _NARRATIVE_TEMPLATES.get(task, _NARRATIVE_TEMPLATES["research"])
    narrative = template.format(subject=subject)
    return f"{narrative}\nOriginal request: {raw_prompt}"


def build_verification(task: str) -> str:
    """Imperative self-check verification pattern per task type."""
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
            "All call sites are updated consistently.",
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
        f"Before you finish, verify:\n"
        f"{numbered}\n"
        f"  {n}. Your answer is grounded in actual code, not assumptions.\n"
        f"  {n+1}. No existing functionality is broken by your changes."
    )
