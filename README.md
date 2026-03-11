# Context Engineer

Local codebase indexing and intelligent prompt enhancement for AI coding agents.

Two components work together to give Claude Code (and other MCP clients) deep codebase awareness:

## Components

### 1. MCP Codebase Index Server (`mcp-codebase-index/`)

A standalone MCP server that indexes source code directories and exposes retrieval tools.

**Features:**
- Three-layer hybrid retrieval: structural (tree-sitter + PageRank), semantic (LanceDB embeddings), keyword (ripgrep)
- Real-time file watching with incremental re-indexing
- 6 MCP tools: `search_codebase`, `get_file_summary`, `get_repo_map`, `get_recent_changes`, `get_dependencies`, `index_status`
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
      "args": ["/path/to/mcp-codebase-index/dist/index.js", "--path", "."]
    }
  }
}
```

**CLI Options:**
- `--path <dir>` — Directory to index (required)
- `--no-watch` — Disable file watching
- `--exclude <patterns>` — Comma-separated glob patterns to exclude

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
┌─────────────────────────────────────────────────┐
│              Claude Code / MCP Client            │
│                                                  │
│  ┌──────────────────┐  ┌──────────────────────┐ │
│  │ Prompt Enhancer  │→→│  MCP Codebase Index  │ │
│  │ (Skill)          │  │  (Server)            │ │
│  └──────────────────┘  └──────────────────────┘ │
│         ↓                        ↓               │
│  Enhanced prompt          6 MCP tools            │
│  with codebase context    for retrieval          │
└─────────────────────────────────────────────────┘
```

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Language (server) | TypeScript (ESM) |
| AST parsing | web-tree-sitter (WASM) |
| Embeddings | all-MiniLM-L6-v2 via ONNX |
| Vector DB | LanceDB (embedded, file-based) |
| Metadata | SQLite via better-sqlite3 |
| File watching | @parcel/watcher |
| Keyword search | ripgrep subprocess |
| MCP transport | Stdio |
| Skill scripts | Python 3 (stdlib only) |

## Requirements

- Node.js >= 18
- Python 3.10+
- ripgrep (`rg`) installed and on PATH

## Project Structure

```
context-engineer-local/
├── mcp-codebase-index/          # MCP server
│   ├── src/
│   │   ├── index.ts             # Entry point + CLI
│   │   ├── server/              # MCP tool registration
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
