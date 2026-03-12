/**
 * In-memory directed dependency graph built from symbol definition/reference tags.
 * Nodes = file paths. Edges = "file A references a symbol defined in file B".
 * Implements PageRank to rank files by importance.
 */

import type { SymbolTag } from '../indexer/ast-chunker.js';
import type { MetadataStore } from './metadata-store.js';

const PAGERANK_ITERATIONS = 20;
const PAGERANK_DAMPING = 0.85;
const DEFAULT_TOP_N = 20;

export interface GraphStats {
  nodeCount: number;
  edgeCount: number;
}

export class TagGraphStore {
  /** Outgoing edges: file → set of files it depends on */
  private outEdges: Map<string, Set<string>> = new Map();
  /** Incoming edges: file → set of files that depend on it */
  private inEdges: Map<string, Set<string>> = new Map();
  /** Last computed PageRank scores */
  private pageRankScores: Map<string, number> = new Map();
  /** Definition symbol names per file, populated during buildFromTags */
  private fileDefs: Map<string, string[]> = new Map();

  private ensureNode(file: string): void {
    if (!this.outEdges.has(file)) this.outEdges.set(file, new Set());
    if (!this.inEdges.has(file)) this.inEdges.set(file, new Set());
  }

  /**
   * Rebuild the graph from a fresh list of symbol tags.
   * Call this after each full index run.
   *
   * Algorithm:
   * 1. Collect all 'def' tags → map symbol name → defining file
   * 2. For each 'ref' tag → if symbol defined elsewhere, add edge ref-file → def-file
   */
  buildFromTags(tags: SymbolTag[]): void {
    this.outEdges.clear();
    this.inEdges.clear();
    this.pageRankScores.clear();
    this.fileDefs.clear();

    // Map: symbol name → file that defines it (last definition wins)
    const defs = new Map<string, string>();
    for (const tag of tags) {
      if (tag.kind === 'def') {
        defs.set(tag.name, tag.filePath);
        this.ensureNode(tag.filePath);
        // Accumulate definition names per file
        const existing = this.fileDefs.get(tag.filePath);
        if (existing) {
          existing.push(tag.name);
        } else {
          this.fileDefs.set(tag.filePath, [tag.name]);
        }
      }
    }

    // For each reference, add an edge from referencing file to defining file
    for (const tag of tags) {
      if (tag.kind !== 'ref') continue;
      const defFile = defs.get(tag.name);
      if (!defFile || defFile === tag.filePath) continue; // skip self-refs

      this.ensureNode(tag.filePath);
      this.outEdges.get(tag.filePath)!.add(defFile);
      this.inEdges.get(defFile)!.add(tag.filePath);
    }

    this.computePageRank();
  }

  /**
   * Add individual tags incrementally (for partial re-index).
   * Triggers a PageRank recompute.
   */
  addTags(tags: SymbolTag[]): void {
    const defs = new Map<string, string>();
    for (const tag of tags) {
      if (tag.kind === 'def') {
        defs.set(tag.name, tag.filePath);
        this.ensureNode(tag.filePath);
      }
    }

    for (const tag of tags) {
      if (tag.kind !== 'ref') continue;
      const defFile = defs.get(tag.name);
      if (!defFile || defFile === tag.filePath) continue;

      this.ensureNode(tag.filePath);
      this.outEdges.get(tag.filePath)!.add(defFile);
      this.inEdges.get(defFile)!.add(tag.filePath);
    }

    this.computePageRank();
  }

  /**
   * Remove all edges associated with a file (when the file is deleted).
   */
  removeFile(filePath: string): void {
    // Remove as source
    const outs = this.outEdges.get(filePath);
    if (outs) {
      for (const target of outs) {
        this.inEdges.get(target)?.delete(filePath);
      }
    }
    // Remove as target
    const ins = this.inEdges.get(filePath);
    if (ins) {
      for (const source of ins) {
        this.outEdges.get(source)?.delete(filePath);
      }
    }
    this.outEdges.delete(filePath);
    this.inEdges.delete(filePath);
    this.pageRankScores.delete(filePath);
  }

  /**
   * Iterative PageRank with damping factor.
   * Score represents the "importance" of a file in the codebase graph.
   */
  private computePageRank(): void {
    const nodes = [...this.outEdges.keys()];
    const n = nodes.length;
    if (n === 0) return;

    const scores = new Map<string, number>();
    const initial = 1.0 / n;
    for (const node of nodes) scores.set(node, initial);

    for (let iter = 0; iter < PAGERANK_ITERATIONS; iter++) {
      const next = new Map<string, number>();
      for (const node of nodes) next.set(node, (1 - PAGERANK_DAMPING) / n);

      for (const [source, targets] of this.outEdges) {
        if (targets.size === 0) continue;
        const contribution = (PAGERANK_DAMPING * scores.get(source)!) / targets.size;
        for (const target of targets) {
          next.set(target, (next.get(target) ?? 0) + contribution);
        }
      }

      for (const node of nodes) scores.set(node, next.get(node)!);
    }

    this.pageRankScores = scores;
  }

  /**
   * Return files sorted by PageRank score descending.
   * @param topN Maximum number of results (default 20)
   */
  getRankedFiles(topN = DEFAULT_TOP_N): Array<{ filePath: string; score: number }> {
    return [...this.pageRankScores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, topN)
      .map(([filePath, score]) => ({ filePath, score }));
  }

  /**
   * Get definition symbol names for a file, populated during buildFromTags.
   */
  getDefinitions(filePath: string): string[] {
    return this.fileDefs.get(filePath) ?? [];
  }

  /**
   * Get files that this file depends on (outgoing edges).
   */
  getDependencies(filePath: string): string[] {
    return [...(this.outEdges.get(filePath) ?? [])];
  }

  /**
   * Get files that depend on this file (incoming edges).
   */
  getDependents(filePath: string): string[] {
    return [...(this.inEdges.get(filePath) ?? [])];
  }

  /**
   * Load edges from the MetadataStore SQLite database and rebuild the in-memory graph.
   * Call this on server startup after indexing to avoid full tag rebuild.
   * Falls back to existing in-memory state if the DB has no edges.
   */
  loadFromDb(metadataStore: MetadataStore): void {
    const edges = metadataStore.getAllEdges();
    if (edges.length === 0) return;

    this.outEdges.clear();
    this.inEdges.clear();
    this.pageRankScores.clear();

    for (const edge of edges) {
      this.ensureNode(edge.fromFile);
      this.ensureNode(edge.toFile);
      this.outEdges.get(edge.fromFile)!.add(edge.toFile);
      this.inEdges.get(edge.toFile)!.add(edge.fromFile);
    }

    this.computePageRank();
  }

  getStats(): GraphStats {
    let edgeCount = 0;
    for (const targets of this.outEdges.values()) edgeCount += targets.size;
    return { nodeCount: this.outEdges.size, edgeCount };
  }
}
