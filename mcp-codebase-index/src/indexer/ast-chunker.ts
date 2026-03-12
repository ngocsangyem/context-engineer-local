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

    // Extract ref tags from import statements to populate dependency graph
    tags.push(...extractImportRefs(root, filePath));

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

/* ── Import ref extraction ─────────────────────────────────────────── */

/** AST node types representing import statements across languages */
const IMPORT_NODE_TYPES = new Set([
  'import_statement',          // JS/TS: import { X } from './file'
  'import_from_statement',     // Python: from module import X
  'import_declaration',        // Go: import "pkg"
  'use_declaration',           // Rust: use crate::module::Type
]);

/** Keywords/noise that appear as identifiers but aren't real symbol refs */
const IMPORT_NOISE_WORDS = new Set([
  'import', 'from', 'as', 'type', 'typeof',
  'crate', 'self', 'super',  // Rust path segments
]);

/**
 * Walk import statements in the AST and produce 'ref' tags for imported symbols.
 * These ref tags feed TagGraphStore.buildFromTags() to create dependency edges.
 */
function extractImportRefs(root: Parser.SyntaxNode, filePath: string): SymbolTag[] {
  const refs: SymbolTag[] = [];
  for (const node of root.children) {
    if (!IMPORT_NODE_TYPES.has(node.type)) continue;
    collectIdentifiers(node, filePath, refs);
  }
  return refs;
}

/**
 * Recursively walk an import node's children to find imported identifiers.
 * Handles named imports, default imports, and namespace imports across languages.
 */
function collectIdentifiers(
  node: Parser.SyntaxNode,
  filePath: string,
  refs: SymbolTag[]
): void {
  // For import_specifier nodes (e.g. `import { Foo as Bar }`), extract the
  // *original* exported name, not the local alias. tree-sitter field 'name'
  // points to the original; first named child is the fallback.
  if (node.type === 'import_specifier' || node.type === 'import_spec'
      || node.type === 'dotted_name') {
    const nameNode = node.childForFieldName('name') ?? node.namedChildren[0];
    const name = nameNode?.text ?? node.text;
    if (name && !IMPORT_NOISE_WORDS.has(name)) {
      refs.push({ name, kind: 'ref', filePath, line: node.startPosition.row + 1 });
    }
    return; // Don't recurse into specifier children (avoid duplicates)
  }

  // Skip namespace imports (`import * as ns`) — 'ns' is a local alias, not a symbol ref
  if (node.type === 'namespace_import' || node.type === 'namespace_import_clause') {
    return;
  }

  // Bare identifiers that are imported symbol names
  if (node.type === 'identifier' || node.type === 'type_identifier') {
    const name = node.text;
    // Only capture identifiers that look like symbol names (not string literals, paths)
    if (name && !IMPORT_NOISE_WORDS.has(name) && /^[A-Za-z_$]/.test(name)) {
      refs.push({ name, kind: 'ref', filePath, line: node.startPosition.row + 1 });
    }
    return;
  }

  // Recurse into children (named_imports, import_clause, etc.)
  for (const child of node.children) {
    // Skip string literals (import paths like './file') — not symbol refs
    if (child.type === 'string' || child.type === 'string_literal' ||
        child.type === 'interpreted_string_literal' || child.type === 'raw_string_literal') {
      continue;
    }
    collectIdentifiers(child, filePath, refs);
  }
}
