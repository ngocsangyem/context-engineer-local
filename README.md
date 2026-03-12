# Context Engineer

Local codebase indexing and intelligent prompt enhancement for AI coding agents.

Two components work together to give Claude Code (and other MCP clients) deep codebase awareness:

## Components

### 1. MCP Codebase Index Server (`mcp-codebase-index/`)

A standalone MCP server that indexes source code directories and exposes retrieval tools.

**Features:**

- Three-layer hybrid retrieval: structural (tree-sitter + PageRank), semantic (LanceDB embeddings), keyword (ripgrep)
- Real-time file watching with incremental re-indexing
- 7 MCP tools: `search_codebase`, `get_file_summary`, `get_repo_map`, `get_recent_changes`, `get_dependencies`, `search_symbols`, `index_status`
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

**Performance Targets:**

- Initial index: 10K files in <60s
- Incremental update: <2s
- Query latency: <200ms
- Memory: <500MB for 10K files

### 2. Prompt Enhancer Skill (`skills/prompt-enhancer/`)

A Claude Code skill that queries the MCP server to automatically enrich user prompts with relevant codebase context.

**Features:**

- Auto-detects task type (coding, debug, review, refactor, research)
- Intensity levels (light, standard, deep) control scaffolding amount
- Context-first prompt ordering (per Anthropic best practices)
- Best-practice blocks: `<investigate_before_answering>`, `<grounding>`, `<anti_overengineering>`, `<use_parallel_tool_calls>`
- Graceful degradation when MCP server is unavailable

**Script Usage:**

```bash
python3 skills/prompt-enhancer/scripts/enhance-prompt.py "Fix the auth timeout bug"
python3 skills/prompt-enhancer/scripts/enhance-prompt.py "Rename variable" --intensity light
python3 skills/prompt-enhancer/scripts/enhance-prompt.py "Refactor auth" --intensity deep --budget 8192
```

**Setup as a Claude Code Skill:**

1. Copy the skill into your project's `.claude/skills/` directory:

```bash
cp -r skills/prompt-enhancer /path/to/your-project/.claude/skills/prompt-enhancer
```

2. The skill activates automatically when Claude Code detects coding tasks. You can also invoke it explicitly:

```
> Use the prompt-enhancer skill to enrich my prompt: "Fix the auth timeout bug"
> @prompt-enhancer Refactor the payment module for better separation of concerns
```

3. For best results, make sure the MCP codebase index server is running (see above). Without it, the skill still works but uses Claude's built-in file tools instead of the indexed context.

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
│                       │ 7 MCP tools, 4 Resources,      │  │
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
| Embeddings        | all-MiniLM-L6-v2 via ONNX      |
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
├── mcp-codebase-index/          # MCP server
│   ├── data/                    # Index data (gitignored, persists across restarts)
│   ├── src/
│   │   ├── index.ts             # Stdio entry point + CLI
│   │   ├── express-server.ts    # HTTP entry point (Express + StreamableHTTPServerTransport)
│   │   ├── server/              # MCP tool, resource, prompt registration
│   │   │   ├── mcp-server-setup.ts
│   │   │   ├── mcp-resource-handlers.ts
│   │   │   ├── mcp-prompt-handlers.ts
│   │   │   └── server-init.ts   # Shared service initialization
│   │   ├── indexer/             # File scanning, AST chunking, embeddings
│   │   ├── storage/             # LanceDB, SQLite, tag graph
│   │   ├── retrieval/           # Hybrid search, ranking
│   │   ├── watcher/             # File change detection
│   │   └── utils/               # Language detection, gitignore, tokens
│   ├── package.json
│   └── tsconfig.json
├── skills/
│   └── prompt-enhancer/         # Claude Code skill
│       ├── SKILL.md             # Skill definition
│       ├── scripts/
│       │   ├── enhance-prompt.py    # Main prompt builder
│       │   ├── detect-intensity.py  # Intensity detection
│       │   └── prompt-blocks.py     # XML block builders
│       └── references/
│           ├── context-injection-patterns.md
│           └── task-type-strategies.md
├── plans/                       # Implementation plans
└── docs/                        # Project documentation
```

## Acknowledgments

- Prompt Enhancer skill inspired by [prompt-leverage](https://github.com/hoangnb24/skills/tree/main/.agents/skills/prompt-leverage) by [@hoangnb24](https://github.com/hoangnb24)
- MCP server architecture informed by research on Cursor, Windsurf, Augment, Continue.dev, Cody, Aider, and Codex indexing strategies
- Prompt best practices from [Anthropic's prompting guide](https://docs.anthropic.com/en/docs/build-with-claude/prompt-engineering/overview)

## License

Private project.
