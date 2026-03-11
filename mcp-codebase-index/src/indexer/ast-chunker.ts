/**
 * AST-based code chunker using web-tree-sitter (WASM).
 * Extracts top-level functions, classes, methods, and type definitions as indexable chunks.
 * Also extracts symbol definition/reference tags for the dependency graph.
 */

import Parser from 'web-tree-sitter';
import {
  classifyNodeType,
  extractNodeName,
  splitLargeNode,
  wholeFileChunk,
  exceedsTokenLimit,
} from './ast-node-classifier.js';

export interface CodeChunk {
  /** Unique id: filePath:startLine-endLine */
  id: string;
  name: string;
  type: 'function' | 'class' | 'method' | 'type' | 'module';
  content: string;
  /** Short signature or first line */
  signature: string;
  startLine: number;
  endLine: number;
  filePath: string;
  language: string;
}

export interface SymbolTag {
  name: string;
  kind: 'def' | 'ref';
  filePath: string;
  line: number;
}

export interface ChunkResult {
  chunks: CodeChunk[];
  tags: SymbolTag[];
}

let parserInitialized = false;

/**
 * Initialize the web-tree-sitter WASM runtime.
 * Must be called once before parsing.
 */
export async function initParser(): Promise<void> {
  if (parserInitialized) return;
  await Parser.init();
  parserInitialized = true;
}

/**
 * Parse a source file and extract code chunks + symbol tags.
 * Falls back to whole-file module chunk if parsing fails.
 *
 * @param filePath Absolute path (used for IDs and tags)
 * @param content Raw file content
 * @param language Tree-sitter language name
 */
export async function chunkFile(
  filePath: string,
  content: string,
  language: string
): Promise<ChunkResult> {
  const chunks: CodeChunk[] = [];
  const tags: SymbolTag[] = [];
  const lines = content.split('\n');

  try {
    await initParser();

    // Attempt to load the grammar; fall back to whole-file chunk if unavailable
    let parser: Parser;
    try {
      parser = new Parser();
      const wasmUrl = new URL(
        `../../node_modules/tree-sitter-${language}/tree-sitter-${language}.wasm`,
        import.meta.url
      );
      const Language = await Parser.Language.load(wasmUrl.pathname);
      parser.setLanguage(Language);
    } catch {
      return wholeFileChunk(filePath, content, language);
    }

    const tree = parser.parse(content);
    const root = tree.rootNode;

    // Walk top-level children looking for chunk-worthy nodes
    for (const node of root.children) {
      if (!node.isNamed) continue;

      const nodeContent = lines.slice(node.startPosition.row, node.endPosition.row + 1).join('\n');
      if (nodeContent.trim().length === 0) continue;

      const name = extractNodeName(node);
      const chunkType = classifyNodeType(node.type);

      // Record definition tag
      tags.push({ name, kind: 'def', filePath, line: node.startPosition.row + 1 });

      if (exceedsTokenLimit(nodeContent)) {
        chunks.push(...splitLargeNode(node, filePath, language, content));
      } else {
        chunks.push({
          id: `${filePath}:${node.startPosition.row + 1}-${node.endPosition.row + 1}`,
          name,
          type: chunkType,
          content: nodeContent,
          signature: nodeContent.split('\n')[0].trim().slice(0, 120),
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          filePath,
          language,
        });
      }
    }

    // If no named top-level chunks found, use whole file
    if (chunks.length === 0) {
      return wholeFileChunk(filePath, content, language);
    }
  } catch (err) {
    process.stderr.write(`Warning: AST parsing failed for ${filePath}: ${err}\n`);
    return wholeFileChunk(filePath, content, language);
  }

  return { chunks, tags };
}
