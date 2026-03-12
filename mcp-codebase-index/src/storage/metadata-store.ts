/**
 * SQLite metadata store for file indexing state.
 * Tracks file paths, content hashes, timestamps, chunk counts, and language.
 * Stored at <indexDir>/metadata.db via better-sqlite3.
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import type { SymbolRecord } from '../models/symbol.js';

export interface DependencyEdge {
  fromFile: string;
  toFile: string;
  kind: string;
  symbols: string[];
  fromLine: number;
}

export interface FileMetadata {
  path: string;
  hash: string;
  lastIndexed: number;
  chunkCount: number;
  language: string;
}

export interface IndexStats {
  fileCount: number;
  totalChunks: number;
  oldestIndexed: number | null;
  newestIndexed: number | null;
}

export class MetadataStore {
  private db: Database.Database;

  constructor(indexDir: string) {
    // Ensure the index directory exists
    fs.mkdirSync(indexDir, { recursive: true });
    const dbPath = path.join(indexDir, 'metadata.db');
    this.db = new Database(dbPath);
    this.initSchema();
  }

  /** Create tables if they do not already exist. */
  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS files (
        path        TEXT    PRIMARY KEY,
        hash        TEXT    NOT NULL,
        last_indexed INTEGER NOT NULL,
        chunk_count  INTEGER NOT NULL DEFAULT 0,
        language    TEXT    NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS idx_files_last_indexed ON files(last_indexed);

      CREATE TABLE IF NOT EXISTS symbols (
        id              TEXT PRIMARY KEY,
        name            TEXT NOT NULL,
        qualified_name  TEXT NOT NULL,
        kind            TEXT NOT NULL,
        file_path       TEXT NOT NULL,
        start_line      INTEGER NOT NULL,
        end_line        INTEGER NOT NULL,
        signature       TEXT NOT NULL DEFAULT '',
        parent_symbol   TEXT,
        visibility      TEXT NOT NULL DEFAULT 'internal',
        language        TEXT NOT NULL DEFAULT '',
        parameters      TEXT,
        return_type     TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
      CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_path);
      CREATE INDEX IF NOT EXISTS idx_symbols_kind ON symbols(kind);

      CREATE TABLE IF NOT EXISTS dependency_edges (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        from_file TEXT NOT NULL,
        to_file   TEXT NOT NULL,
        kind      TEXT NOT NULL DEFAULT 'import',
        symbols   TEXT,
        from_line INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_dep_from ON dependency_edges(from_file);
      CREATE INDEX IF NOT EXISTS idx_dep_to ON dependency_edges(to_file);
    `);
  }

  /**
   * Get the stored SHA-256 hash for a file path.
   * Returns null if the file has never been indexed.
   */
  getFileHash(filePath: string): string | null {
    const row = this.db
      .prepare<[string], { hash: string }>('SELECT hash FROM files WHERE path = ?')
      .get(filePath);
    return row?.hash ?? null;
  }

  /**
   * Insert or update metadata for an indexed file.
   */
  setFileMetadata(
    filePath: string,
    hash: string,
    chunkCount: number,
    language: string
  ): void {
    this.db
      .prepare(
        `INSERT INTO files (path, hash, last_indexed, chunk_count, language)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET
           hash         = excluded.hash,
           last_indexed = excluded.last_indexed,
           chunk_count  = excluded.chunk_count,
           language     = excluded.language`
      )
      .run(filePath, hash, Date.now(), chunkCount, language);
  }

  /**
   * Identify files that are in the metadata store but no longer present
   * in the current file scan (i.e. they have been deleted).
   *
   * @param currentFilePaths Array of absolute paths from the latest scan
   * @returns Paths that exist in DB but not in currentFilePaths
   */
  getStaleFiles(currentFilePaths: string[]): string[] {
    if (currentFilePaths.length === 0) {
      const rows = this.db
        .prepare<[], { path: string }>('SELECT path FROM files')
        .all();
      return rows.map((r) => r.path);
    }

    // SQLite has no native array param; use a temp table approach for large sets
    // For simplicity, query all and filter in JS (adequate for <100k files)
    const rows = this.db
      .prepare<[], { path: string }>('SELECT path FROM files')
      .all();
    const currentSet = new Set(currentFilePaths);
    return rows.map((r) => r.path).filter((p) => !currentSet.has(p));
  }

  /**
   * Remove a file's metadata record.
   */
  removeFile(filePath: string): void {
    this.db.prepare('DELETE FROM files WHERE path = ?').run(filePath);
  }

  /**
   * Remove metadata for multiple files in a single transaction.
   */
  removeFiles(filePaths: string[]): void {
    const del = this.db.prepare('DELETE FROM files WHERE path = ?');
    const tx = this.db.transaction((paths: string[]) => {
      for (const p of paths) del.run(p);
    });
    tx(filePaths);
  }

  /** Return aggregate statistics about the index. */
  getStats(): IndexStats {
    const row = this.db
      .prepare<
        [],
        {
          fileCount: number;
          totalChunks: number;
          oldestIndexed: number | null;
          newestIndexed: number | null;
        }
      >(
        `SELECT
           COUNT(*)        AS fileCount,
           SUM(chunk_count) AS totalChunks,
           MIN(last_indexed) AS oldestIndexed,
           MAX(last_indexed) AS newestIndexed
         FROM files`
      )
      .get()!;

    return {
      fileCount: row.fileCount,
      totalChunks: row.totalChunks ?? 0,
      oldestIndexed: row.oldestIndexed,
      newestIndexed: row.newestIndexed,
    };
  }

  /* ── Symbol index methods ──────────────────────────────────────────── */

  /** Upsert symbols for a file (replaces all existing symbols for that file). */
  upsertSymbols(filePath: string, symbols: SymbolRecord[]): void {
    const del = this.db.prepare('DELETE FROM symbols WHERE file_path = ?');
    const ins = this.db.prepare(
      `INSERT INTO symbols (id, name, qualified_name, kind, file_path, start_line, end_line,
        signature, parent_symbol, visibility, language, parameters, return_type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const tx = this.db.transaction((fp: string, syms: SymbolRecord[]) => {
      del.run(fp);
      for (const s of syms) {
        ins.run(
          s.id, s.name, s.qualifiedName, s.kind, s.filePath,
          s.startLine, s.endLine, s.signature,
          s.parentSymbol ?? null, s.visibility, s.language,
          s.parameters ? JSON.stringify(s.parameters) : null,
          s.returnType ?? null
        );
      }
    });
    tx(filePath, symbols);
  }

  /** Remove all symbols for a file. */
  removeSymbols(filePath: string): void {
    this.db.prepare('DELETE FROM symbols WHERE file_path = ?').run(filePath);
  }

  /** Search symbols by name (prefix match) and optional kind filter. */
  searchSymbols(
    query: string,
    kind?: string,
    limit = 20
  ): SymbolRecord[] {
    let sql = `SELECT * FROM symbols WHERE name LIKE ?`;
    const params: (string | number)[] = [`${query}%`];

    if (kind) {
      sql += ` AND kind = ?`;
      params.push(kind);
    }

    sql += ` ORDER BY
      CASE WHEN name = ? THEN 0 WHEN name LIKE ? THEN 1 ELSE 2 END,
      visibility = 'exported' DESC,
      name ASC
      LIMIT ?`;
    params.push(query, `${query}%`, limit);

    const rows = this.db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    return rows.map(rowToSymbol);
  }

  /** Get all symbols defined in a file. */
  getFileSymbols(filePath: string): SymbolRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM symbols WHERE file_path = ? ORDER BY start_line')
      .all(filePath) as Array<Record<string, unknown>>;
    return rows.map(rowToSymbol);
  }

  /* ── Dependency edge methods ───────────────────────────────────────── */

  /**
   * Replace all edges for a given source file (atomic delete + insert).
   * edges is the full set of outgoing edges from fromFile.
   */
  upsertEdges(fromFile: string, edges: Omit<DependencyEdge, 'fromFile'>[]): void {
    const del = this.db.prepare('DELETE FROM dependency_edges WHERE from_file = ?');
    const ins = this.db.prepare(
      `INSERT INTO dependency_edges (from_file, to_file, kind, symbols, from_line)
       VALUES (?, ?, ?, ?, ?)`
    );
    const tx = this.db.transaction(() => {
      del.run(fromFile);
      for (const e of edges) {
        ins.run(fromFile, e.toFile, e.kind, e.symbols.length > 0 ? JSON.stringify(e.symbols) : null, e.fromLine);
      }
    });
    tx();
  }

  /** Remove all edges where from_file matches. Called on file deletion. */
  removeEdges(fromFile: string): void {
    this.db.prepare('DELETE FROM dependency_edges WHERE from_file = ?').run(fromFile);
  }

  /** Get all outgoing edges from a file. */
  getEdges(filePath: string): DependencyEdge[] {
    const rows = this.db
      .prepare<[string], Record<string, unknown>>(
        'SELECT * FROM dependency_edges WHERE from_file = ? ORDER BY from_line'
      )
      .all(filePath);
    return rows.map(rowToEdge);
  }

  /** Get all edges in the database. Used by TagGraphStore to load graph on startup. */
  getAllEdges(): DependencyEdge[] {
    const rows = this.db
      .prepare<[], Record<string, unknown>>('SELECT * FROM dependency_edges')
      .all();
    return rows.map(rowToEdge);
  }

  /** Close the database connection. */
  close(): void {
    this.db.close();
  }
}

/** Map a SQLite row to a DependencyEdge. */
function rowToEdge(row: Record<string, unknown>): DependencyEdge {
  return {
    fromFile: row.from_file as string,
    toFile: row.to_file as string,
    kind: row.kind as string,
    symbols: row.symbols ? JSON.parse(row.symbols as string) : [],
    fromLine: row.from_line as number,
  };
}

/** Map a SQLite row to a SymbolRecord. */
function rowToSymbol(row: Record<string, unknown>): SymbolRecord {
  return {
    id: row.id as string,
    name: row.name as string,
    qualifiedName: row.qualified_name as string,
    kind: row.kind as SymbolRecord['kind'],
    filePath: row.file_path as string,
    startLine: row.start_line as number,
    endLine: row.end_line as number,
    signature: row.signature as string,
    parentSymbol: (row.parent_symbol as string) ?? undefined,
    visibility: row.visibility as 'exported' | 'internal',
    language: row.language as string,
    parameters: row.parameters ? JSON.parse(row.parameters as string) : undefined,
    returnType: (row.return_type as string) ?? undefined,
  };
}
