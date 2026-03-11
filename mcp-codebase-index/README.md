# mcp-codebase-index

MCP server for real-time codebase semantic indexing and retrieval. Provides hybrid search (semantic + keyword + structural), dependency graphs, and file importance ranking via PageRank.

## Data Storage

Index data is stored in `mcp-codebase-index/data/<project-slug>/`, **not** inside the indexed project directory.

```
mcp-codebase-index/
├── data/
│   ├── my-app-a1b2c3/        # per-project data
│   │   ├── metadata.db       # SQLite — file hashes, timestamps, chunk counts
│   │   └── vectors/           # LanceDB — code chunk embeddings
│   └── other-project-d4e5f6/
├── src/
└── ...
```

- **Project slug**: `<basename>-<6char-sha256>` derived from the `--path` argument
- **Auto-created**: directories are created on first run if they don't exist
- **Gitignored**: `data/` is excluded from version control

## Restart Behavior

On restart (MCP server stop → start):

1. Server checks if `data/<slug>/metadata.db` exists with entries
2. If **existing index found**: runs incremental indexing — skips unchanged files (hash check), indexes new/modified, prunes deleted
3. If **no index found**: runs full initial index
4. TagGraphStore (in-memory dependency graph) is always rebuilt from the AST pass — fast and consistent

Real-time file watching (`--watch`, enabled by default) keeps the index up-to-date during a session.

## Usage

```bash
# Basic usage
node dist/index.js --path /path/to/your/project

# With options
node dist/index.js --path /path/to/project --no-watch --exclude "vendor,tmp"
```

### CLI Options

| Flag                   | Default  | Description                        |
| ---------------------- | -------- | ---------------------------------- |
| `--path <dir>`         | required | Directory to index                 |
| `--watch`              | enabled  | Watch for file changes (real-time) |
| `--no-watch`           | —        | Disable file watching              |
| `--exclude <patterns>` | —        | Comma-separated exclude patterns   |

## MCP Tools

| Tool                 | Description                                          |
| -------------------- | ---------------------------------------------------- |
| `search_codebase`    | Hybrid semantic + keyword + structural search        |
| `get_file_summary`   | Structural outline (symbols, imports, dependents)    |
| `get_repo_map`       | PageRank-sorted file importance overview             |
| `get_recent_changes` | Recent git commits and change stats                  |
| `get_dependencies`   | Import graph for a file (direct + transitive)        |
| `index_status`       | Index stats, data path, last-indexed time, staleness |

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
