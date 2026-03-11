#!/usr/bin/env python3
"""
prompt-blocks.py — XML block builders for enhanced prompts.

Generates conditional prompt blocks based on task type and intensity level.
Blocks follow Anthropic's Claude Code best practices: investigate before
answering, ground responses in code, avoid overengineering, use parallel tools.

No external dependencies — stdlib only.
"""

from __future__ import annotations


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
