# Context Engineer

Local codebase indexing and intelligent prompt enhancement for AI coding agents.

Two components work together to give Claude Code (and other MCP clients) deep codebase awareness:

## Components

### 1. MCP Codebase Index Server (`mcp-codebase-index/`)

A standalone MCP server that indexes source code directories and exposes retrieval tools.

**Features:**

- Three-layer hybrid retrieval: structural (tree-sitter + PageRank), semantic (LanceDB embeddings), keyword (ripgrep)
- Real-time file watching with incremental re-indexing
- 8 MCP tools: `search_codebase`, `get_file_summary`, `get_repo_map`, `get_recent_changes`, `get_dependencies`, `get_call_graph`, `search_symbols`, `index_status`
- Fully local — no cloud dependencies

**Quick Start:**

```bash
cd mcp-codebase-index
pnpm install
pnpm build
node dist/index.js --path /path/to/your/repo
```

**With Claude Code (`.mcp.json`):**

```json
{
  "mcpServers": {
    "codebase-index": {
      "command": "node",
      "args": [
        "/path/to/mcp-codebase-index/dist/index.js",
        "--path",
        "/path/to/your/repo"
      ]
    }
  }
}
```

**HTTP Transport:**

Start the HTTP server for web-based MCP clients (Cursor, web IDEs, etc.):

```bash
cd mcp-codebase-index
pnpm install
pnpm build
node dist/express-server.js --path /path/to/your/repo --port 3847
```

**With Claude Code (HTTP config in `.mcp.json`):**

```json
{
  "mcpServers": {
    "codebase-index": {
      "transport": "http",
      "url": "http://127.0.0.1:3847/mcp"
    }
  }
}
```

Or use the CLI:

```bash
claude mcp add --transport http codebase-index http://127.0.0.1:3847/mcp
```

**CLI Options:**

- `--path <dir>` — Directory to index (required)
- `--port <num>` — HTTP port (default: 3847)
- `--no-watch` — Disable file watching
- `--exclude <patterns>` — Comma-separated glob patterns to exclude
- `--pool-size <N>` — Number of embedding worker threads (default: min(4, cpu count))

**Data Storage:**

Index data persists in `mcp-codebase-index/data/<project-slug>/` (not inside the indexed project). Each project gets a unique slug (`<basename>-<6char-hash>`). On restart, the server detects existing index data and runs incremental indexing only — skipping unchanged files, indexing new/modified, and pruning deleted ones.

```
mcp-codebase-index/data/
├── my-app-a1b2c3/        # per-project index
│   ├── metadata.db       # file hashes, timestamps, chunk counts
│   └── vectors/           # LanceDB embeddings
└── other-repo-d4e5f6/
```

To reset an index: `rm -rf mcp-codebase-index/data/<project-slug>/`

**MCP Resources:**

Clients can browse indexed data via 4 MCP resources:

- `codebase://stats` — Index statistics (file count, chunks, vectors, graph nodes)
- `codebase://files` — All indexed files with language and chunk count
- `codebase://file/{path}` — File symbols, imports, and dependents (URI template)
- `codebase://symbols/{kind}` — All symbols of a given kind (URI template)

**MCP Prompts:**

Built-in guided exploration prompts:

- `explore-codebase` — Guided overview: repo map, key files, architecture
- `find-implementation` — Locate where a feature is implemented
- `analyze-dependencies` — Deep dependency analysis for a file
- `review-changes` — Review recent code changes with full context

**Performance:**

- Streaming pipeline: Parse → Embed → Store run concurrently with backpressure
- Worker thread embedding: ONNX inference on configurable worker pool (default: 4 threads)
- Batch I/O: SQLite and LanceDB writes batched across files (50x fewer transactions)
- Smart change detection: 3-tier (git diff → mtime → content hash) for near-instant incremental updates
- Optional INT8 quantized model: `python scripts/quantize-model.py` for 2-3x faster embeddings

### 2. Prompt Enhancer Skill (`skills/prompt-enhancer/`)

A Claude Code skill that enriches user prompts with relevant codebase context. Works standalone using the agent's built-in file tools (Read, Grep, Glob); optionally enhanced by the MCP codebase index server for semantic search and dependency graphs.

**Features:**

- Auto-detects task type (coding, debug, review, refactor, research)
- Intensity levels (light, standard, deep) control scaffolding amount
- Context-first prompt ordering (per Anthropic best practices)
- Best-practice blocks: `<investigate_before_answering>`, `<grounding>`, `<anti_overengineering>`, `<use_parallel_tool_calls>`
- **Works without MCP server** — uses built-in file tools (Read, Grep, Glob) for context discovery
- **Hybrid retrieval** for refactor/review tasks — runs MCP + file-tools in parallel when MCP is available
- **Quality gates** — automatically falls back to file-tools when MCP returns low-quality results
- **Framework-aware queries** — generates optimized Grep patterns for Vue, React, Svelte, Python, Go, TypeScript
- **External AI provider** — optionally offload prompt improvement to Gemini, Ollama, or OpenAI-compatible APIs (saves Claude tokens)

**Script Usage:**

```bash
python3 skills/prompt-enhancer/scripts/enhance-prompt.py "Fix the auth timeout bug"
python3 skills/prompt-enhancer/scripts/enhance-prompt.py "Rename variable" --intensity light
python3 skills/prompt-enhancer/scripts/enhance-prompt.py "Refactor auth" --intensity deep --budget 8192
python3 skills/prompt-enhancer/scripts/enhance-prompt.py "Fix auth bug" --provider gemini
```

**External AI Provider (Optional):**

Offload prompt refinement to an external model instead of using Claude's context window. Set via env vars or `.mcp.json`:

```bash
# Via .env file in skill folder
PROMPT_ENHANCER_PROVIDER=gemini   # or ollama, openai, none
GEMINI_API_KEY=your-key

# Ollama
PROMPT_ENHANCER_PROVIDER=ollama
OLLAMA_MODEL=llama3.2
OLLAMA_BASE_URL=http://localhost:11434
```

> Note: Do not commit/upload the `.env` file

Supports Gemini (SDK), Ollama (local HTTP), and any OpenAI-compatible API (vLLM, LM Studio, Groq). Falls back to deterministic output on any failure.

**Setup as a Claude Code Skill:**

**Option A — Install via Skills CLI (recommended):**

```bash
npx skills add ngocsangyem/context-engineer-local@prompt-enhancer

# Direct path to a skill in a repo
npx skills add https://github.com/ngocsangyem/context-engineer-local/tree/main/skills/prompt-enhancer
```

This installs the skill into `.claude/skills/prompt-enhancer/` automatically.

**Option B — Manual copy:**

```bash
cp -r skills/prompt-enhancer /path/to/your-project/.claude/skills/prompt-enhancer
```

Once installed, the skill activates automatically when Claude Code detects coding tasks. You can also invoke it explicitly:

```
> Use the prompt-enhancer skill to enrich my prompt: "Fix the auth timeout bug"
> @prompt-enhancer Refactor the payment module for better separation of concerns
```

The skill works immediately using the agent's built-in file tools (Read, Grep, Glob). For richer context (semantic search, dependency graphs, repo maps), optionally run the MCP codebase index server (see above). When both are available, the skill uses hybrid retrieval — combining MCP results with file-tool results for maximum coverage.

**As a Hook (auto-enhance with `--enhancer` flag):**

Instead of manually invoking the skill each time, install the hook so any prompt with `--enhancer` is automatically enhanced:

1. Copy the hook script into your project:

```bash
cp skills/prompt-enhancer/hooks/prompt-enhancer-hook.cjs /path/to/your-project/.claude/hooks/
```

2. Register it in your project's `.claude/settings.json` (or `.claude/settings.local.json`):

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "type": "command",
        "command": "node \"$CLAUDE_PROJECT_DIR/.claude/hooks/prompt-enhancer-hook.cjs\"",
        "timeout": 15
      }
    ]
  }
}
```

3. Use it by appending `--enhancer` to any prompt:

```
Fix the auth timeout bug --enhancer
Refactor the payment module --enhancer
```

The hook runs `enhance-prompt.py`, then Claude shows you the enhanced prompt and asks whether to use it as-is, let you modify it, or skip enhancement.

## Architecture

```
┌────────────────────────────────────────────────────────────┐
│                 Claude Code / MCP Client                   │
│                                                            │
│  ┌─────────────────┐  ┌────────────────────────────────┐  │
│  │ Prompt Enhancer │  │ MCP Codebase Index (Server)    │  │
│  │ (Skill)         │→→│                                │  │
│  └─────────────────┘  │ Transport:                     │  │
│         ↓             │ • Stdio (index.ts)             │  │
│  Enhanced prompt      │ • HTTP Express (express-       │  │
│  with codebase        │   server.ts, port 3847)        │  │
│  context              │                                │  │
│                       │ 8 MCP tools, 4 Resources,      │  │
│                       │ 4 Prompts for retrieval        │  │
│                       └────────────────────────────────┘  │
└────────────────────────────────────────────────────────────┘
```

## Supported Languages

TypeScript, JavaScript (JSX/TSX), Python, Go, Rust, Java, Kotlin, Scala, C#, C/C++, Ruby, PHP, Swift, Dart, Elixir, Lua, Vue, Svelte, HTML, CSS/SCSS, SQL, Bash/Shell, YAML, TOML

## Tech Stack

| Component         | Technology                     |
| ----------------- | ------------------------------ |
| Language (server) | TypeScript (ESM)               |
| AST parsing       | web-tree-sitter (WASM)         |
| Embeddings        | all-MiniLM-L6-v2 via ONNX (worker threads) |
| Vector DB         | LanceDB (embedded, file-based) |
| Metadata          | SQLite via better-sqlite3      |
| File watching     | @parcel/watcher                |
| Keyword search    | ripgrep subprocess             |
| MCP transport     | Stdio + HTTP (Express)         |
| Skill scripts     | Python 3 (stdlib only)         |

## Requirements

- Node.js >= 18
- Python 3.10+
- ripgrep (`rg`) installed and on PATH

## Project Structure

```
context-engineer-local/
├── mcp-codebase-index/          # MCP server (optional — skill works without it)
│   ├── data/                    # Index data (gitignored, persists across restarts)
│   ├── src/
│   │   ├── index.ts             # Stdio entry point + CLI
│   │   ├── express-server.ts    # HTTP entry point (Express + StreamableHTTPServerTransport)
│   │   ├── server/              # MCP tool, resource, prompt registration
│   │   │   ├── mcp-server-setup.ts
│   │   │   ├── mcp-resource-handlers.ts
│   │   │   ├── mcp-prompt-handlers.ts
│   │   │   ├── mcp-result-formatters.ts
│   │   │   └── server-init.ts   # Shared service initialization
│   │   ├── models/              # Data models (symbol definitions)
│   │   ├── indexer/             # File scanning, AST chunking, embeddings
│   │   ├── storage/             # LanceDB, SQLite, tag graph
│   │   ├── retrieval/           # Hybrid search, ranking
│   │   ├── watcher/             # File change detection
│   │   └── utils/               # Language detection, gitignore, tokens
│   ├── package.json
│   └── tsconfig.json
├── skills/
│   └── prompt-enhancer/         # Claude Code skill (works standalone)
│       ├── SKILL.md             # Skill definition — quality gates, hybrid retrieval, framework-aware queries
│       ├── scripts/
│       │   ├── enhance-prompt.py        # Main prompt builder + --provider integration
│       │   ├── external-ai-enhance.py   # External AI providers (Gemini/Ollama/OpenAI)
│       │   ├── detect-intensity.py      # Intensity detection
│       │   └── prompt-blocks.py         # XML block builders
│       └── references/
│           ├── context-injection-patterns.md  # MCP + file-tool result formatting
│           └── task-type-strategies.md        # Per-task retrieval strategies, quality gates, framework hints
├── plans/                       # Implementation plans
└── docs/                        # Project documentation
```

## Acknowledgments

- Prompt Enhancer skill inspired by [prompt-leverage](https://github.com/hoangnb24/skills/tree/main/.agents/skills/prompt-leverage) by [@hoangnb24](https://github.com/hoangnb24)
- MCP server architecture informed by research on Cursor, Windsurf, Augment, Continue.dev, Cody, Aider, and Codex indexing strategies
- Prompt best practices from [Anthropic's prompting guide](https://docs.anthropic.com/en/docs/build-with-claude/prompt-engineering/overview)

## License

Private project.
