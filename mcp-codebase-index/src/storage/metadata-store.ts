/**
 * SQLite metadata store for file indexing state.
 * Tracks file paths, content hashes, timestamps, chunk counts, and language.
 * Stored at <indexDir>/metadata.db via better-sqlite3.
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import type { SymbolRecord } from '../models/symbol.js';
import { batchWriteFileResults, batchRemoveFiles, type FileWriteResult } from './metadata-store-batch-ops.js';

export type { FileWriteResult };

export interface CallEdge {
  callerFile: string;
  callerSymbol: string;
  callerLine: number;
  calleeName: string;
  calleeFile: string | null;
}

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
      CREATE INDEX IF NOT EXISTS idx_files_last_indexed ON files(last_indexed);`);

    // Migration: add mtime column if it doesn't exist (safe on existing DBs)
    const cols = this.db.prepare("PRAGMA table_info(files)").all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'mtime')) {
      this.db.exec('ALTER TABLE files ADD COLUMN mtime INTEGER');
    }

    this.db.exec(`

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

      CREATE TABLE IF NOT EXISTS call_edges (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        caller_file  TEXT NOT NULL,
        caller_symbol TEXT NOT NULL,
        caller_line  INTEGER NOT NULL,
        callee_name  TEXT NOT NULL,
        callee_file  TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_call_caller ON call_edges(caller_file);
      CREATE INDEX IF NOT EXISTS idx_call_callee ON call_edges(callee_name);
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
   * Get the last_indexed timestamp (ms epoch) for a file.
   * Returns null if the file has never been indexed.
   */
  getFileLastIndexed(filePath: string): number | null {
    const row = this.db
      .prepare<[string], { last_indexed: number }>('SELECT last_indexed FROM files WHERE path = ?')
      .get(filePath);
    return row?.last_indexed ?? null;
  }

  /**
   * Load all last_indexed timestamps into a Map.
   * Single query — avoids N+1 when checking many files.
   */
  getAllFileLastIndexed(): Map<string, number> {
    const rows = this.db
      .prepare<[], { path: string; last_indexed: number }>('SELECT path, last_indexed FROM files')
      .all();
    const result = new Map<string, number>();
    for (const r of rows) result.set(r.path, r.last_indexed);
    return result;
  }

  /**
   * Get the MAX(last_indexed) across all files — used as the "last full index" timestamp.
   * Returns null if the index is empty.
   */
  getLastIndexTimestamp(): number | null {
    const row = this.db
      .prepare<[], { ts: number | null }>('SELECT MAX(last_indexed) AS ts FROM files')
      .get();
    return row?.ts ?? null;
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
   * Also removes associated symbols, edges, and call_edges.
   */
  removeFiles(filePaths: string[]): void {
    batchRemoveFiles(this.db, filePaths);
  }

  /**
   * Write results for multiple files in a single SQLite transaction.
   * Replaces all symbols, edges, call_edges, and file metadata for each file.
   */
  batchWriteFileResults(results: FileWriteResult[]): void {
    batchWriteFileResults(this.db, results);
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

  /** Get all indexed files with metadata. */
  getAllFiles(): FileMetadata[] {
    const rows = this.db
      .prepare<[], { path: string; hash: string; last_indexed: number; chunk_count: number; language: string }>(
        'SELECT path, hash, last_indexed, chunk_count, language FROM files ORDER BY path'
      )
      .all();
    return rows.map((r) => ({
      path: r.path,
      hash: r.hash,
      lastIndexed: r.last_indexed,
      chunkCount: r.chunk_count,
      language: r.language,
    }));
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

  /* ── Call edge methods ─────────────────────────────────────────────── */

  /** Replace all call edges for a given caller file (atomic delete + insert). */
  upsertCallEdges(callerFile: string, edges: Omit<CallEdge, 'calleeFile'>[]): void {
    const del = this.db.prepare('DELETE FROM call_edges WHERE caller_file = ?');
    const ins = this.db.prepare(
      `INSERT INTO call_edges (caller_file, caller_symbol, caller_line, callee_name, callee_file)
       VALUES (?, ?, ?, ?, NULL)`
    );
    const tx = this.db.transaction(() => {
      del.run(callerFile);
      for (const e of edges) {
        ins.run(callerFile, e.callerSymbol, e.callerLine, e.calleeName);
      }
    });
    tx();
  }

  /** Remove all call edges where caller_file matches. Called on file deletion. */
  removeCallEdges(filePath: string): void {
    this.db.prepare('DELETE FROM call_edges WHERE caller_file = ?').run(filePath);
  }

  /** What functions call symbolName? (reverse lookup) */
  getCallers(symbolName: string, limit = 50): CallEdge[] {
    const rows = this.db
      .prepare<[string, number], Record<string, unknown>>(
        'SELECT * FROM call_edges WHERE callee_name = ? ORDER BY caller_file, caller_line LIMIT ?'
      )
      .all(symbolName, limit);
    return rows.map(rowToCallEdge);
  }

  /** What functions does callerSymbol call? (forward lookup) */
  getCallees(callerFile: string, callerSymbol?: string, limit = 50): CallEdge[] {
    let sql: string;
    let params: (string | number)[];
    if (callerSymbol) {
      sql = 'SELECT * FROM call_edges WHERE caller_file = ? AND caller_symbol = ? ORDER BY caller_line LIMIT ?';
      params = [callerFile, callerSymbol, limit];
    } else {
      sql = 'SELECT * FROM call_edges WHERE caller_file = ? ORDER BY caller_symbol, caller_line LIMIT ?';
      params = [callerFile, limit];
    }
    const rows = this.db.prepare<(string | number)[], Record<string, unknown>>(sql).all(...params);
    return rows.map(rowToCallEdge);
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

/** Map a SQLite row to a CallEdge. */
function rowToCallEdge(row: Record<string, unknown>): CallEdge {
  return {
    callerFile: row.caller_file as string,
    callerSymbol: row.caller_symbol as string,
    callerLine: row.caller_line as number,
    calleeName: row.callee_name as string,
    calleeFile: (row.callee_file as string) ?? null,
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
