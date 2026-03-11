/**
 * SQLite metadata store for file indexing state.
 * Tracks file paths, content hashes, timestamps, chunk counts, and language.
 * Stored at <indexDir>/metadata.db via better-sqlite3.
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

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

  /** Create the files table if it does not already exist. */
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

  /** Close the database connection. */
  close(): void {
    this.db.close();
  }
}
