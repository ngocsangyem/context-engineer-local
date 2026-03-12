/**
 * AST node classification, naming, and splitting utilities.
 * Provides language-agnostic helpers for identifying and categorizing
 * tree-sitter AST nodes into indexable code chunks.
 */

import Parser from 'web-tree-sitter';
import { countTokens } from '../utils/token-counter.js';
import type { CodeChunk, ChunkResult } from './ast-chunker.js';

export const MAX_CHUNK_TOKENS = 2000;

// Node types considered top-level chunks per language family
export const CHUNK_NODE_TYPES = new Set([
  // TypeScript / JavaScript
  'function_declaration',
  'function_expression',
  'arrow_function',
  'class_declaration',
  'class_expression',
  'method_definition',
  'export_statement',
  'lexical_declaration',   // const/let at module level
  'variable_declaration',  // var at module level
  // Python
  'function_definition',
  'class_definition',
  'decorated_definition',
  // Go
  'function_declaration',
  'method_declaration',
  'type_declaration',
  // Rust
  'function_item',
  'struct_item',
  'impl_item',
  'trait_item',
  'enum_item',
  // Java / C#
  'method_declaration',
  'class_declaration',
  'interface_declaration',
  // Generic
  'type_alias_declaration',
  'interface_declaration',
]);

/**
 * Determine the semantic chunk type from a tree-sitter node type string.
 */
export function classifyNodeType(nodeType: string): CodeChunk['type'] {
  if (nodeType.includes('class')) return 'class';
  if (nodeType.includes('method')) return 'method';
  if (nodeType.includes('function') || nodeType.includes('arrow')) return 'function';
  if (nodeType.includes('type') || nodeType.includes('interface')) return 'type';
  return 'module';
}

/**
 * Extract the name of a node by looking for identifier children.
 */
export function extractNodeName(node: Parser.SyntaxNode): string {
  for (const child of node.children) {
    if (child.type === 'identifier' || child.type === 'name' || child.type === 'property_identifier') {
      return child.text;
    }
  }
  return node.type;
}

/**
 * Split a large chunk's children into smaller sub-chunks.
 * Used when a single AST node exceeds MAX_CHUNK_TOKENS.
 */
export function splitLargeNode(
  node: Parser.SyntaxNode,
  filePath: string,
  language: string,
  content: string
): CodeChunk[] {
  const lines = content.split('\n');
  const results: CodeChunk[] = [];

  for (const child of node.children) {
    if (!child.isNamed) continue;
    const childContent = lines
      .slice(child.startPosition.row, child.endPosition.row + 1)
      .join('\n');
    if (childContent.trim().length === 0) continue;

    results.push({
      id: `${filePath}:${child.startPosition.row + 1}-${child.endPosition.row + 1}`,
      name: extractNodeName(child),
      type: classifyNodeType(child.type),
      content: childContent,
      signature: childContent.split('\n')[0].trim().slice(0, 120),
      startLine: child.startPosition.row + 1,
      endLine: child.endPosition.row + 1,
      filePath,
      language,
    });
  }

  return results;
}

/**
 * Create a single module-level chunk for the entire file.
 * Used when AST parsing is unavailable or yields no chunks.
 */
export function wholeFileChunk(filePath: string, content: string, language: string): ChunkResult {
  const lineCount = content.split('\n').length;
  return {
    chunks: [
      {
        id: `${filePath}:1-${lineCount}`,
        name: filePath.split('/').pop() ?? filePath,
        type: 'module',
        content,
        signature: content.split('\n')[0].trim().slice(0, 120),
        startLine: 1,
        endLine: lineCount,
        filePath,
        language,
      },
    ],
    tags: [],
    rootNode: null,
  };
}

/**
 * Check if a node's content exceeds the maximum token limit.
 */
export function exceedsTokenLimit(nodeContent: string): boolean {
  return countTokens(nodeContent) > MAX_CHUNK_TOKENS;
}
