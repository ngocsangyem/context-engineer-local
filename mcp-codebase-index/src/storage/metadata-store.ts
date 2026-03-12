/**
 * SQLite metadata store for file indexing state.
 * Tracks file paths, content hashes, timestamps, chunk counts, and language.
 * Stored at <indexDir>/metadata.db via better-sqlite3.
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import type { SymbolRecord } from '../models/symbol.js';

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

  /** Close the database connection. */
  close(): void {
    this.db.close();
  }
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
