/**
 * LanceDB vector store for code chunk embeddings.
 * File-based embedded database — no separate process required.
 * Stored at <indexDir>/vectors/
 */

import path from 'path';
import type { CodeChunk } from '../indexer/ast-chunker.js';
import { VECTOR_DIM } from '../indexer/embedding-generator.js';

// LanceDB record schema
export interface VectorRecord {
  id: string;
  vector: Float32Array;
  filePath: string;
  chunkName: string;
  chunkType: string;
  startLine: number;
  endLine: number;
  content: string;
  language: string;
}

export interface SearchResult {
  record: VectorRecord;
  /** Cosine distance (lower = more similar) */
  distance: number;
}

// Lazily-loaded LanceDB connection
type LanceConnection = Awaited<ReturnType<typeof import('@lancedb/lancedb').connect>>;
type LanceTable = Awaited<ReturnType<LanceConnection['openTable']>>;

export class LanceVectorStore {
  private readonly dbPath: string;
  private connection: LanceConnection | null = null;
  private table: LanceTable | null = null;
  private readonly tableName = 'chunks';

  constructor(indexDir: string) {
    this.dbPath = path.join(indexDir, 'vectors');
  }

  /** Open (or create) the LanceDB database and chunks table. */
  async init(): Promise<void> {
    const lancedb = await import('@lancedb/lancedb');
    this.connection = await lancedb.connect(this.dbPath);

    const tableNames = await this.connection.tableNames();
    if (tableNames.includes(this.tableName)) {
      this.table = await this.connection.openTable(this.tableName);
    } else {
      // Create table with a seed record to establish schema
      const seed: Record<string, unknown> = {
        id: '__seed__',
        vector: Array.from(new Float32Array(VECTOR_DIM)),
        filePath: '',
        chunkName: '',
        chunkType: '',
        startLine: 0,
        endLine: 0,
        content: '',
        language: '',
      };
      this.table = await this.connection.createTable(this.tableName, [seed]);
      // Remove the seed record immediately
      await this.table.delete(`id = '__seed__'`);
    }
  }

  private ensureReady(): LanceTable {
    if (!this.table) throw new Error('LanceVectorStore not initialized — call init() first');
    return this.table;
  }

  /**
   * Upsert code chunks with their embeddings.
   * Deletes existing records for each filePath before inserting new ones.
   */
  async upsert(chunks: CodeChunk[], embeddings: Float32Array[]): Promise<void> {
    if (chunks.length === 0) return;
    const table = this.ensureReady();

    // Group by filePath for efficient deletion
    const filePaths = [...new Set(chunks.map((c) => c.filePath))];
    for (const fp of filePaths) {
      await this.deleteByFile(fp);
    }

    const records: Record<string, unknown>[] = chunks.map((chunk, i) => ({
      id: chunk.id,
      // LanceDB expects a plain number array for float vectors
      vector: Array.from(embeddings[i]),
      filePath: chunk.filePath,
      chunkName: chunk.name,
      chunkType: chunk.type,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      content: chunk.content,
      language: chunk.language,
    }));

    await table.add(records);
  }

  /**
   * Search for the nearest chunks to a query vector.
   * @param queryVector 384-dim embedding
   * @param limit Maximum number of results to return
   */
  async search(queryVector: Float32Array, limit = 10): Promise<SearchResult[]> {
    const table = this.ensureReady();
    const rows = await table
      .vectorSearch(queryVector)
      .limit(limit)
      .toArray();

    return rows.map((row) => ({
      record: {
        id: row['id'] as string,
        vector: row['vector'] as Float32Array,
        filePath: row['filePath'] as string,
        chunkName: row['chunkName'] as string,
        chunkType: row['chunkType'] as string,
        startLine: row['startLine'] as number,
        endLine: row['endLine'] as number,
        content: row['content'] as string,
        language: row['language'] as string,
      },
      distance: row['_distance'] as number ?? 0,
    }));
  }

  /**
   * Remove all vector records for a given file.
   */
  async deleteByFile(filePath: string): Promise<void> {
    const table = this.ensureReady();
    // Escape single quotes in path
    const escaped = filePath.replace(/'/g, "''");
    // LanceDB SQL parser lowercases unquoted identifiers; double-quote camelCase fields
    await table.delete(`"filePath" = '${escaped}'`);
  }

  /** Return total number of indexed chunks. */
  async count(): Promise<number> {
    const table = this.ensureReady();
    return table.countRows();
  }
}
