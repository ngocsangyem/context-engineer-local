#!/usr/bin/env python3
"""Offload prompt improvement to external AI (Gemini/Ollama/OpenAI-compatible).
Returns the original enhanced prompt on any failure — never breaks the pipeline."""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path
from textwrap import dedent
from urllib.parse import quote as url_quote
from urllib.request import Request, urlopen

# Import resolve_env — ancestor traversal works from skills/ and .claude/skills/
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

# Fallback: load .env from skill dir (resolve_env only checks .claude/skills/)
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

_SKILL = "prompt-enhancer"
_VALID_PROVIDERS = {"gemini", "ollama", "openai", "none"}
_TIMEOUT = 15  # seconds — fast fail for better UX
_MIN_RESPONSE_LEN = 100  # minimum chars for valid AI response


def _has_required_keys(provider: str) -> bool:
    """Check if the required API keys/config exist for the given provider."""
    if provider == "gemini":
        return bool(resolve_env("GEMINI_API_KEY", skill=_SKILL))
    if provider == "openai":
        return bool(resolve_env("OPENAI_API_KEY", skill=_SKILL))
    if provider == "ollama":
        return True  # Ollama is local, no API key needed
    return False


def _resolve_provider(override: str | None = None) -> str:
    """Determine which provider to use. Returns 'none' if keys are missing."""
    provider = (override or resolve_env("PROMPT_ENHANCER_PROVIDER", skill=_SKILL) or "none").lower().strip()
    if provider not in _VALID_PROVIDERS:
        print(f"[prompt-enhancer] Unknown provider '{provider}', skipping external AI.", file=sys.stderr)
        return "none"
    if provider != "none" and not _has_required_keys(provider):
        print(f"[prompt-enhancer] {provider} configured but API key missing, skipping external AI.", file=sys.stderr)
        return "none"
    return provider


def _build_system_prompt() -> str:
    """Condensed SKILL.md rules for external AI context."""
    return dedent("""\
        You are a prompt engineering expert. Improve the given enhanced prompt.

        CRITICAL FORMAT RULE:
        The input prompt uses XML tags like <tool_rules>, <objective>, <verification>, etc.
        Your output MUST keep EVERY XML tag exactly as-is. Do NOT strip, rename, or omit any tag.
        The output must start with <tool_rules> and contain all original XML blocks in order.

        Improvement rules:
        - Improve specificity WITHIN each XML block: add concrete details, file paths, function names
        - Sharpen the <objective> block with better action verbs and clearer deliverables
        - Keep <done_criteria> measurable and testable
        - Do NOT add code implementations — only improve the prompt instructions
        - Do NOT hallucinate file names or code that wasn't in the original
        - If codebase context is provided, use REAL file paths and function names from it
        - Prefer codebase context over generic improvements — ground the prompt in actual code
        - Order context before the query: longform data and tool results go at top, the user's actual question goes at bottom
        - Bias toward action: prefer "do X" over "consider doing X" — be direct and imperative
        - Avoid excessive caveats: one caveat per block is enough. Don't hedge every statement
        - Keep blocks focused: each XML block should have ONE clear purpose
        - Preserve block order: tool_rules first, objective near bottom, done_criteria last
        - Output ONLY the improved prompt — no commentary, no markdown fences, no explanation""")


def _build_user_content(raw: str, enhanced: str, mcp_context: str | None = None) -> str:
    """Format the user message for the external AI."""
    parts = [f"Raw user prompt:\n{raw}"]
    if mcp_context:
        parts.append(f"\n{mcp_context}")
    parts.append(f"\nDeterministic enhanced prompt to improve:\n{enhanced}")
    return "\n".join(parts)


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
    ollama_timeout = int(resolve_env("OLLAMA_TIMEOUT", skill=_SKILL) or 120)
    with urlopen(req, timeout=ollama_timeout) as resp:
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
_MCP_CONTEXT_TIMEOUT = 5  # seconds — fast fail, don't block the pipeline


def _query_mcp_context(query: str, limit: int = 5) -> str | None:
    """Query MCP codebase-index REST API for relevant context. Returns None if unavailable."""
    base_url = (resolve_env("MCP_CODEBASE_URL", skill=_SKILL) or "http://127.0.0.1:3847").rstrip("/")
    try:
        url = f"{base_url}/api/context?q={url_quote(query)}&limit={limit}"
        req = Request(url)
        with urlopen(req, timeout=_MCP_CONTEXT_TIMEOUT) as resp:
            data = json.loads(resp.read().decode())
        results = data.get("results", [])
        if not results:
            return None
        lines = ["Codebase context (from MCP codebase index):"]
        for r in results[:limit]:
            path = r.get("filePath", r.get("file", "unknown"))
            snippet = r.get("content", r.get("text", ""))[:500]
            score = r.get("score", "")
            lines.append(f"\n--- {path} (score: {score}) ---\n{snippet}")
        return "\n".join(lines)
    except Exception:
        return None  # MCP unavailable — silent fallback


def _validate_response(response: str, enhanced_prompt: str) -> bool:
    """Check AI response preserves XML structure and has meaningful content."""
    if len(response.strip()) <= _MIN_RESPONSE_LEN:
        return False
    original_tags = set(re.findall(r"<(\w+)>", enhanced_prompt))
    response_tags = set(re.findall(r"<(\w+)>", response))
    missing = original_tags - response_tags
    if missing:
        print(f"[prompt-enhancer] AI response missing XML tags: {missing}", file=sys.stderr)
        return False
    return True


_MODEL_DEFAULTS = {"gemini": "gemini-2.5-flash", "ollama": "llama3.2", "openai": "gpt-4o-mini"}
_MODEL_ENV_KEYS = {"gemini": "GEMINI_MODEL", "ollama": "OLLAMA_MODEL", "openai": "OPENAI_MODEL"}


def _resolve_model_name(provider: str) -> str:
    """Get the model name for logging."""
    env_key = _MODEL_ENV_KEYS.get(provider, "")
    return resolve_env(env_key, skill=_SKILL) or _MODEL_DEFAULTS.get(provider, "unknown") if env_key else "unknown"


def enhance_via_external_ai(raw_prompt: str, enhanced_prompt: str, provider: str | None = None) -> str:
    """Send enhanced prompt to external AI for improvement. Returns original on any failure."""
    resolved = _resolve_provider(provider)
    if resolved == "none":
        return enhanced_prompt
    call_fn = _PROVIDERS.get(resolved)
    if not call_fn:
        return enhanced_prompt
    model_name = _resolve_model_name(resolved)
    print(f"[prompt-enhancer] Enhancing via {resolved} (model: {model_name})...", file=sys.stderr)
    try:
        mcp_context = _query_mcp_context(raw_prompt)
        if mcp_context:
            print("[prompt-enhancer] MCP context retrieved, enriching external AI call.", file=sys.stderr)
        system = _build_system_prompt()
        user = _build_user_content(raw_prompt, enhanced_prompt, mcp_context)
        result = call_fn(system, user)
        if _validate_response(result, enhanced_prompt):
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
