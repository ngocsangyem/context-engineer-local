/**
 * Extracts unresolved call edges from AST function bodies.
 * Records "functionA calls nameB" without resolving which file nameB lives in.
 * Simplified approach: 70% value at 10% cost compared to full resolution.
 */

import type Parser from 'web-tree-sitter';
import type { SymbolRecord } from '../models/symbol.js';

export interface RawCallEdge {
  callerFile: string;
  callerSymbol: string;
  callerLine: number;
  calleeName: string;
}

/**
 * Common callee names that are not worth tracking (noise filter).
 * Covers console, Promise, Object, Array, String/RegExp, and global functions.
 */
const CALL_NOISE = new Set([
  // console
  'log', 'warn', 'error', 'info', 'debug', 'trace',
  // Promise
  'resolve', 'reject', 'all', 'race', 'allSettled',
  // Object
  'keys', 'values', 'entries', 'assign', 'freeze',
  // Array
  'push', 'pop', 'map', 'filter', 'reduce', 'forEach', 'find', 'some', 'every',
  // String/RegExp
  'join', 'split', 'trim', 'slice', 'replace', 'match', 'test',
  // globals
  'parseInt', 'parseFloat', 'isNaN', 'isFinite',
  'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
  'require',
]);

/** AST node types representing function-like constructs */
const FUNCTION_NODE_TYPES = new Set([
  'function_declaration',
  'function_expression',
  'arrow_function',
  'method_definition',
  'function',
]);

/**
 * Extract the callee name from a call_expression node.
 * - Simple call: `doSomething()` → "doSomething"
 * - Member call: `obj.method()` → "method"
 * - Chained: `a.b.c()` → "c"
 * Returns null if name cannot be determined or is noise.
 */
function extractCalleeName(callNode: Parser.SyntaxNode): string | null {
  // The first named child of call_expression is the function/callee
  const calleeNode = callNode.firstNamedChild;
  if (!calleeNode) return null;

  if (calleeNode.type === 'identifier') {
    const name = calleeNode.text;
    return CALL_NOISE.has(name) ? null : name;
  }

  if (calleeNode.type === 'member_expression') {
    // Take the property (right side) of member expression
    const propNode = calleeNode.childForFieldName('property');
    const name = propNode?.text ?? null;
    if (!name) return null;
    return CALL_NOISE.has(name) ? null : name;
  }

  return null;
}

/**
 * Walk an AST node recursively and collect all call_expression nodes.
 * Limited depth to avoid traversing deeply nested lambdas.
 */
function collectCallExpressions(node: Parser.SyntaxNode, depth: number, results: Parser.SyntaxNode[]): void {
  if (depth > 8) return;

  for (const child of node.children) {
    if (child.type === 'call_expression') {
      results.push(child);
    }
    // Recurse but skip nested function definitions to keep caller context clean
    if (!FUNCTION_NODE_TYPES.has(child.type)) {
      collectCallExpressions(child, depth + 1, results);
    }
  }
}

/**
 * Determine the enclosing function name for a call site.
 * Returns the symbol's qualifiedName if the call is within its range.
 */
function findCallerSymbol(line: number, symbols: SymbolRecord[]): string {
  // Find innermost enclosing function/method
  let best: SymbolRecord | null = null;
  for (const sym of symbols) {
    if (
      (sym.kind === 'function' || sym.kind === 'method') &&
      sym.startLine <= line &&
      sym.endLine >= line
    ) {
      if (!best || sym.startLine > best.startLine) {
        best = sym;
      }
    }
  }
  return best?.qualifiedName ?? '<module>';
}

/**
 * Extract unresolved call edges from a parsed AST root.
 * Walks all top-level function/method bodies and records their call expressions.
 *
 * @param rootNode Parsed AST root (from chunkFile result)
 * @param filePath Absolute path of the source file
 * @param symbols Symbols already extracted for this file (for caller identification)
 * @returns Array of raw call edges (callee unresolved)
 */
export function extractCallEdges(
  rootNode: Parser.SyntaxNode,
  filePath: string,
  symbols: SymbolRecord[]
): RawCallEdge[] {
  const edges: RawCallEdge[] = [];
  const seen = new Set<string>(); // deduplicate caller+callee pairs

  // Walk top-level and class-level nodes to find function bodies
  walkForFunctions(rootNode, filePath, symbols, edges, seen);

  return edges;
}

/**
 * Recursively walk AST nodes to find function-like nodes and extract calls from their bodies.
 */
function walkForFunctions(
  node: Parser.SyntaxNode,
  filePath: string,
  symbols: SymbolRecord[],
  edges: RawCallEdge[],
  seen: Set<string>
): void {
  for (const child of node.children) {
    if (FUNCTION_NODE_TYPES.has(child.type)) {
      extractCallsFromBody(child, filePath, symbols, edges, seen);
    } else {
      // Recurse into class bodies, export declarations, etc.
      walkForFunctions(child, filePath, symbols, edges, seen);
    }
  }
}

/**
 * Extract call_expression nodes from a function body and create edges.
 */
function extractCallsFromBody(
  funcNode: Parser.SyntaxNode,
  filePath: string,
  symbols: SymbolRecord[],
  edges: RawCallEdge[],
  seen: Set<string>
): void {
  const callerLine = funcNode.startPosition.row + 1;
  const callerSymbol = findCallerSymbol(callerLine, symbols);

  const callExprs: Parser.SyntaxNode[] = [];
  collectCallExpressions(funcNode, 0, callExprs);

  for (const callNode of callExprs) {
    const calleeName = extractCalleeName(callNode);
    if (!calleeName) continue;

    const callLine = callNode.startPosition.row + 1;
    const key = `${callerSymbol}::${calleeName}`;
    if (seen.has(key)) continue;
    seen.add(key);

    edges.push({
      callerFile: filePath,
      callerSymbol,
      callerLine: callLine,
      calleeName,
    });
  }
}
