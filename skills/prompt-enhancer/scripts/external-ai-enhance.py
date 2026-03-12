#!/usr/bin/env python3
"""
external-ai-enhance.py — Offload prompt improvement to external AI providers.

Accepts a raw prompt + deterministic enhanced prompt, sends to an external AI
(Gemini, Ollama, or OpenAI-compatible) for refinement. Returns the original
enhanced prompt on any failure — never breaks the enhancement pipeline.

Providers: gemini (SDK), ollama (HTTP/stdlib), openai (HTTP/stdlib).
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from textwrap import dedent
from urllib.request import Request, urlopen

# ---------------------------------------------------------------------------
# Import resolve_env from .claude/scripts/ — works from both locations:
#   skills/prompt-enhancer/scripts/ (parents[3] = project root)
#   .claude/skills/prompt-enhancer/scripts/ (parents[3] = .claude/)
# ---------------------------------------------------------------------------
_SCRIPT_DIR = Path(__file__).resolve().parent
for _ancestor in _SCRIPT_DIR.parents:
    _candidate = _ancestor / "scripts" / "resolve_env.py"
    if _candidate.exists():
        sys.path.insert(0, str(_candidate.parent))
        break
try:
    from resolve_env import resolve_env
except ImportError:
    def resolve_env(var: str, **_) -> str | None:  # type: ignore[assignment]
        return os.getenv(var)

# ---------------------------------------------------------------------------
# Fallback: load .env from skill directory (supports skills/ path outside .claude/)
# resolve_env only searches .claude/skills/<skill>/.env — this covers the other location
# ---------------------------------------------------------------------------
_local_env: dict[str, str] = {}
if (_env_path := _SCRIPT_DIR.parent / ".env").exists():
    for _raw_line in _env_path.read_text().splitlines():
        if (_ln := _raw_line.strip()) and not _ln.startswith("#") and "=" in _ln:
            _k, _, _v = _ln.partition("=")
            _local_env[_k.strip()] = _v.strip().strip("'\"")
_base_resolve_env = resolve_env
def resolve_env(var: str, **kw) -> str | None:  # type: ignore[no-redef]
    """Try full hierarchy first, then local .env next to skill directory."""
    return _base_resolve_env(var, **kw) or _local_env.get(var)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
_SKILL = "prompt-enhancer"
_VALID_PROVIDERS = {"gemini", "ollama", "openai", "none"}
_TIMEOUT = 15  # seconds — fast fail for better UX
_MIN_RESPONSE_LEN = 100  # minimum chars for valid AI response


def _resolve_provider(override: str | None = None) -> str:
    """Determine which provider to use from CLI override or env var."""
    provider = (override or resolve_env("PROMPT_ENHANCER_PROVIDER", skill=_SKILL) or "none").lower().strip()
    if provider not in _VALID_PROVIDERS:
        print(f"[prompt-enhancer] Unknown provider '{provider}', falling back to deterministic mode.", file=sys.stderr)
        return "none"
    return provider


def _build_system_prompt() -> str:
    """Condensed SKILL.md rules for external AI context."""
    return dedent("""\
        You are a prompt engineering expert. Improve the given enhanced prompt.

        Rules:
        - Preserve ALL XML tags and structure (<tool_rules>, <objective>, <verification>, etc.)
        - Improve specificity: add concrete details, file paths, function names where possible
        - Sharpen the <objective> block with better action verbs and clearer deliverables
        - Keep <done_criteria> measurable and testable
        - Do NOT add code implementations — only improve the prompt instructions
        - Do NOT remove any existing XML blocks
        - Do NOT hallucinate file names or code that wasn't in the original
        - Output ONLY the improved prompt — no commentary, no markdown fences""")


def _build_user_content(raw: str, enhanced: str) -> str:
    """Format the user message for the external AI."""
    return f"Raw user prompt:\n{raw}\n\nDeterministic enhanced prompt to improve:\n{enhanced}"


# ---------------------------------------------------------------------------
# Provider implementations
# ---------------------------------------------------------------------------

def _call_gemini(system: str, user: str) -> str:
    """Call Gemini via google-genai SDK."""
    try:
        from google import genai
        from google.genai import types
    except ImportError:
        raise RuntimeError("google-genai package not installed. Install: pip install google-genai")
    api_key = resolve_env("GEMINI_API_KEY", skill=_SKILL)
    if not api_key:
        raise RuntimeError("GEMINI_API_KEY not configured")
    model = resolve_env("GEMINI_MODEL", skill=_SKILL) or "gemini-2.5-flash"
    client = genai.Client(api_key=api_key)
    response = client.models.generate_content(
        model=model,
        contents=[user],
        config=types.GenerateContentConfig(
            system_instruction=system,
            http_options={"timeout": _TIMEOUT * 1000},
        ),
    )
    return response.text or ""


def _call_ollama(system: str, user: str) -> str:
    """Call Ollama via HTTP REST API (stdlib only)."""
    base_url = (resolve_env("OLLAMA_BASE_URL", skill=_SKILL) or "http://localhost:11434").rstrip("/")
    model = resolve_env("OLLAMA_MODEL", skill=_SKILL) or "llama3.2"
    payload = json.dumps({
        "model": model,
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
        "stream": False,
    }).encode("utf-8")
    req = Request(f"{base_url}/api/chat", data=payload, headers={"Content-Type": "application/json"})
    with urlopen(req, timeout=_TIMEOUT) as resp:
        result = json.loads(resp.read().decode())
    return result.get("message", {}).get("content", "")


def _call_openai(system: str, user: str) -> str:
    """Call OpenAI-compatible API via HTTP (stdlib only)."""
    api_key = resolve_env("OPENAI_API_KEY", skill=_SKILL)
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY not configured")
    base_url = (resolve_env("OPENAI_BASE_URL", skill=_SKILL) or "https://api.openai.com/v1").rstrip("/")
    model = resolve_env("OPENAI_MODEL", skill=_SKILL) or "gpt-4o-mini"
    payload = json.dumps({
        "model": model,
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
        "max_tokens": 4096,
    }).encode("utf-8")
    req = Request(f"{base_url}/chat/completions", data=payload, headers={
        "Content-Type": "application/json",
        "Authorization": f"Bearer {api_key}",
    })
    with urlopen(req, timeout=_TIMEOUT) as resp:
        result = json.loads(resp.read().decode())
    choices = result.get("choices", [])
    if not choices:
        return ""
    return choices[0].get("message", {}).get("content", "")


_PROVIDERS = {"gemini": _call_gemini, "ollama": _call_ollama, "openai": _call_openai}


def _validate_response(response: str) -> bool:
    """Check AI response preserves XML structure and has meaningful content."""
    return "<objective>" in response and len(response.strip()) > _MIN_RESPONSE_LEN


def enhance_via_external_ai(raw_prompt: str, enhanced_prompt: str, provider: str | None = None) -> str:
    """Send enhanced prompt to external AI for improvement. Returns original on any failure."""
    resolved = _resolve_provider(provider)
    if resolved == "none":
        return enhanced_prompt
    call_fn = _PROVIDERS.get(resolved)
    if not call_fn:
        return enhanced_prompt
    print(f"[prompt-enhancer] Enhancing via {resolved}...", file=sys.stderr)
    try:
        system = _build_system_prompt()
        user = _build_user_content(raw_prompt, enhanced_prompt)
        result = call_fn(system, user)
        if _validate_response(result):
            print(f"[prompt-enhancer] AI enhancement successful.", file=sys.stderr)
            return result
        print(f"[prompt-enhancer] AI response failed validation, using deterministic output.", file=sys.stderr)
        return enhanced_prompt
    except Exception as e:
        print(f"[prompt-enhancer] {resolved} failed: {e}. Using deterministic output.", file=sys.stderr)
        return enhanced_prompt


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="Test external AI prompt enhancement.")
    parser.add_argument("prompt", help="Raw prompt to enhance.")
    parser.add_argument("--provider", choices=sorted(_VALID_PROVIDERS - {"none"}), required=True)
    args = parser.parse_args()
    test_enhanced = f"<tool_rules>Test</tool_rules>\n<objective>Test: {args.prompt}</objective>\n<done_criteria>Done.</done_criteria>"
    print(enhance_via_external_ai(args.prompt, test_enhanced, args.provider))
