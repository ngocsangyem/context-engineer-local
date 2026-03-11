#!/usr/bin/env python3
"""
detect-intensity.py — Detect prompt intensity level (light/standard/deep).

Intensity controls how much scaffolding the enhanced prompt receives.
Light tasks get minimal structure; deep tasks get full framework with
investigation, grounding, and anti-overengineering blocks.

No external dependencies — stdlib only.
"""

from __future__ import annotations

import re


# Keywords that signal a deep-intensity task requiring thorough analysis.
DEEP_KEYWORDS: list[str] = [
    "careful", "thorough", "deep dive", "production", "critical",
    "high stakes", "security", "performance", "migration", "architecture",
]

# Keywords that signal a light-intensity task needing minimal scaffolding.
LIGHT_KEYWORDS: list[str] = [
    "quick", "simple", "trivial", "minor", "small", "typo", "rename",
    "formatting", "lint", "style",
]

# Default intensity per task type when no keyword signals are detected.
TASK_DEFAULT_INTENSITY: dict[str, str] = {
    "debug": "standard",
    "coding": "standard",
    "refactor": "standard",
    "review": "standard",
    "research": "light",
}


def detect_intensity(prompt: str, task: str) -> str:
    """Detect intensity from prompt keywords and task type.

    Priority: deep keywords > light keywords > task default.
    Longer prompts (>200 chars) bump light to standard minimum.
    """
    lowered = prompt.lower()

    # Deep keywords override everything (word-boundary match).
    if any(re.search(r'\b' + re.escape(kw) + r'\b', lowered) for kw in DEEP_KEYWORDS):
        return "deep"

    # Light keywords suggest minimal scaffolding (word-boundary match).
    if any(re.search(r'\b' + re.escape(kw) + r'\b', lowered) for kw in LIGHT_KEYWORDS):
        return "light"

    # Fall back to task-type default.
    intensity = TASK_DEFAULT_INTENSITY.get(task, "standard")

    # Long prompts suggest complexity — bump light to standard.
    if intensity == "light" and len(prompt) > 200:
        intensity = "standard"

    return intensity
