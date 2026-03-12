/**
 * Batch write operations for MetadataStore.
 * Extracted to keep metadata-store.ts manageable.
 * Accepts a better-sqlite3 Database instance directly.
 */

import type Database from 'better-sqlite3';
import type { SymbolRecord } from '../models/symbol.js';
import type { DependencyEdge, CallEdge } from './metadata-store.js';

/** Aggregated per-file result used for batched SQLite writes. */
export interface FileWriteResult {
  filePath: string;
  hash: string;
  chunkCount: number;
  language: string;
  symbols: SymbolRecord[];
  edges: Omit<DependencyEdge, 'fromFile'>[];
  callEdges: Omit<CallEdge, 'calleeFile'>[];
}

/**
 * Write results for multiple files in a single SQLite transaction.
 * Replaces all symbols, edges, call_edges, and file metadata for each file.
 */
export function batchWriteFileResults(
  db: Database.Database,
  results: FileWriteResult[]
): void {
  if (results.length === 0) return;

  const delSymbols = db.prepare('DELETE FROM symbols WHERE file_path = ?');
  const insSymbol = db.prepare(
    `INSERT INTO symbols (id, name, qualified_name, kind, file_path, start_line, end_line,
      signature, parent_symbol, visibility, language, parameters, return_type)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const delEdges = db.prepare('DELETE FROM dependency_edges WHERE from_file = ?');
  const insEdge = db.prepare(
    `INSERT INTO dependency_edges (from_file, to_file, kind, symbols, from_line) VALUES (?, ?, ?, ?, ?)`
  );
  const delCallEdges = db.prepare('DELETE FROM call_edges WHERE caller_file = ?');
  const insCallEdge = db.prepare(
    `INSERT INTO call_edges (caller_file, caller_symbol, caller_line, callee_name, callee_file) VALUES (?, ?, ?, ?, NULL)`
  );
  const insMeta = db.prepare(
    `INSERT INTO files (path, hash, last_indexed, chunk_count, language)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET
       hash         = excluded.hash,
       last_indexed = excluded.last_indexed,
       chunk_count  = excluded.chunk_count,
       language     = excluded.language`
  );

  const now = Date.now();
  const tx = db.transaction(() => {
    for (const r of results) {
      delSymbols.run(r.filePath);
      for (const s of r.symbols) {
        insSymbol.run(
          s.id, s.name, s.qualifiedName, s.kind, s.filePath,
          s.startLine, s.endLine, s.signature,
          s.parentSymbol ?? null, s.visibility, s.language,
          s.parameters ? JSON.stringify(s.parameters) : null,
          s.returnType ?? null
        );
      }
      delEdges.run(r.filePath);
      for (const e of r.edges) {
        insEdge.run(r.filePath, e.toFile, e.kind, e.symbols.length > 0 ? JSON.stringify(e.symbols) : null, e.fromLine);
      }
      delCallEdges.run(r.filePath);
      for (const ce of r.callEdges) {
        insCallEdge.run(r.filePath, ce.callerSymbol, ce.callerLine, ce.calleeName);
      }
      insMeta.run(r.filePath, r.hash, now, r.chunkCount, r.language);
    }
  });
  tx();
}

/**
 * Remove metadata and all related records for multiple files in a single transaction.
 * Deletes from symbols, dependency_edges, call_edges, and files tables.
 */
export function batchRemoveFiles(db: Database.Database, filePaths: string[]): void {
  if (filePaths.length === 0) return;
  // SQLite has a max parameter limit (~32766). Chunk to stay safe.
  const CHUNK_SIZE = 500;
  const tx = db.transaction(() => {
    for (let i = 0; i < filePaths.length; i += CHUNK_SIZE) {
      const chunk = filePaths.slice(i, i + CHUNK_SIZE);
      const placeholders = chunk.map(() => '?').join(',');
      db.prepare(`DELETE FROM symbols WHERE file_path IN (${placeholders})`).run(...chunk);
      db.prepare(`DELETE FROM dependency_edges WHERE from_file IN (${placeholders})`).run(...chunk);
      db.prepare(`DELETE FROM call_edges WHERE caller_file IN (${placeholders})`).run(...chunk);
      db.prepare(`DELETE FROM files WHERE path IN (${placeholders})`).run(...chunk);
    }
  });
  tx();
}
