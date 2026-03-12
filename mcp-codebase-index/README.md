# mcp-codebase-index

MCP server for real-time codebase semantic indexing and retrieval. Provides hybrid search (semantic + keyword + structural), dependency graphs, call graphs, symbol search, and file importance ranking via PageRank.

## Data Storage

Index data is stored in `mcp-codebase-index/data/<project-slug>/`, **not** inside the indexed project directory.

```
mcp-codebase-index/
├── data/
│   ├── my-app-a1b2c3/        # per-project data
│   │   ├── metadata.db       # SQLite — file hashes, symbols, deps, call edges
│   │   └── vectors/           # LanceDB — code chunk embeddings
│   └── other-project-d4e5f6/
├── models/
│   └── all-MiniLM-L6-v2.onnx # embedding model (384 dims)
├── src/
└── ...
```

- **Project slug**: `<basename>-<6char-sha256>` derived from the `--path` argument
- **Auto-created**: directories are created on first run if they don't exist
- **Gitignored**: `data/` is excluded from version control

## Restart Behavior

On restart (MCP server stop → start):

1. Server checks if `data/<slug>/metadata.db` exists with entries
2. If **existing index found**: runs incremental indexing — uses git diff + mtime to skip unchanged files, hash check as final authority
3. If **no index found**: runs full initial index via streaming pipeline
4. TagGraphStore (in-memory dependency graph) is always rebuilt from the AST pass

Real-time file watching (`--watch`, enabled by default) keeps the index up-to-date during a session.

## Usage

### Stdio Transport (Claude Code CLI)

```bash
# Basic usage
node dist/index.js --path /path/to/your/project

# With options
node dist/index.js --path /path/to/project --no-watch --exclude "vendor,tmp" --pool-size 8
```

### HTTP Transport (web-based MCP clients)

```bash
# Start HTTP server
node dist/express-server.js --path /path/to/project --port 3848

# Add to Claude Code
claude mcp add --transport http codebase-index http://127.0.0.1:3848/mcp
```

The HTTP server starts immediately and indexes in the background. MCP tools are available as soon as indexing completes. Check status via `GET /health`.

### CLI Options

| Flag                   | Default           | Description                            |
| ---------------------- | ----------------- | -------------------------------------- |
| `--path <dir>`         | required          | Directory to index                     |
| `--watch`              | enabled           | Watch for file changes (real-time)     |
| `--no-watch`           | —                 | Disable file watching                  |
| `--exclude <patterns>` | —                 | Comma-separated exclude patterns       |
| `--pool-size <N>`      | min(4, cpu count) | Number of embedding worker threads     |
| `--port <N>`           | 3847              | HTTP server port (express-server only) |

## MCP Tools

| Tool                 | Description                                          |
| -------------------- | ---------------------------------------------------- |
| `search_codebase`    | Hybrid semantic + keyword + structural + symbol search |
| `get_file_summary`   | Structural outline (symbols, imports, dependents)    |
| `get_repo_map`       | PageRank-sorted file importance overview             |
| `get_recent_changes` | Recent git commits and change stats                  |
| `get_dependencies`   | Import graph for a file (direct + transitive)        |
| `get_call_graph`     | Call graph — callers/callees for a symbol             |
| `search_symbols`     | Search symbol index by name, kind, with signatures   |
| `index_status`       | Index stats, data path, last-indexed time, staleness |

## Performance

The indexing pipeline uses a streaming architecture with concurrent stages:

- **Streaming pipeline**: Parse → Embed → Store run concurrently with backpressure
- **Worker thread embedding**: ONNX inference runs on a pool of worker threads (default: 4)
- **Batch I/O**: SQLite and LanceDB writes are batched across files
- **Smart change detection**: 3-tier system (git diff → mtime → content hash) for fast incremental updates
- **Quantized model support**: Optional INT8 ONNX model for 2-3x faster embeddings

### Model Quantization (Optional)

Generate a quantized INT8 model for faster inference:

```bash
pip install onnxruntime
python scripts/quantize-model.py
```

The worker threads automatically use the quantized model if available, falling back to FP32.

## Clearing the Index

Delete the project's data directory to force a full re-index:

```bash
rm -rf mcp-codebase-index/data/<project-slug>/
```

Or remove all index data:

```bash
rm -rf mcp-codebase-index/data/
```

## Development

```bash
pnpm run build    # compile TypeScript
pnpm run dev      # watch mode compilation
```
