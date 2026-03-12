/**
 * Rich symbol extraction from tree-sitter AST nodes.
 * Scoped to TS/JS with best-effort for other languages.
 * Extracts: name, kind, signature, parameters, return type, parent scope, visibility.
 */

import type Parser from 'web-tree-sitter';
import type { SymbolRecord, SymbolKind, ParameterInfo } from '../models/symbol.js';

/**
 * Extract rich symbol records from a parsed AST tree.
 * Walks top-level nodes and class/interface bodies for nested methods.
 */
export function extractSymbols(
  root: Parser.SyntaxNode,
  filePath: string,
  language: string,
  content: string
): SymbolRecord[] {
  const symbols: SymbolRecord[] = [];
  const lines = content.split('\n'); // Split once, reuse across all symbols

  for (const node of root.children) {
    if (!node.isNamed) continue;

    // Handle export wrappers: `export function/class/...`
    const isExported = isExportNode(node);
    const targetNode = isExported ? getExportedDeclaration(node) : node;
    if (!targetNode) continue;

    const kind = classifyKind(targetNode.type);
    if (!kind) continue;

    // Skip plain variable declarations that aren't function expressions (avoids index noise)
    if (kind === 'variable' && !containsFunctionExpression(targetNode)) continue;

    if (kind === 'class' || kind === 'interface') {
      symbols.push(buildSymbol(targetNode, filePath, language, lines, kind, isExported));
      symbols.push(...extractClassMembers(targetNode, filePath, language, lines, isExported));
    } else {
      symbols.push(buildSymbol(targetNode, filePath, language, lines, kind, isExported));
    }
  }

  return symbols;
}

/* ── Symbol construction ──────────────────────────────────────────── */

function buildSymbol(
  node: Parser.SyntaxNode,
  filePath: string,
  language: string,
  lines: string[],
  kind: SymbolKind,
  isExported: boolean,
  parentName?: string
): SymbolRecord {
  const name = extractName(node) || node.type;
  const qualifiedName = parentName ? `${parentName}.${name}` : name;
  const startLine = node.startPosition.row + 1;
  const endLine = node.endPosition.row + 1;
  const signature = lines[startLine - 1]?.trim().slice(0, 200) || '';

  return {
    id: `${filePath}#${qualifiedName}`,
    name,
    qualifiedName,
    kind,
    filePath,
    startLine,
    endLine,
    signature,
    parentSymbol: parentName,
    visibility: isExported ? 'exported' : 'internal',
    language,
    parameters: extractParameters(node),
    returnType: extractReturnType(node),
  };
}

/* ── Class member extraction ──────────────────────────────────────── */

function extractClassMembers(
  classNode: Parser.SyntaxNode,
  filePath: string,
  language: string,
  lines: string[],
  classIsExported: boolean
): SymbolRecord[] {
  const symbols: SymbolRecord[] = [];
  const className = extractName(classNode) || 'Unknown';

  // Find the class body node
  const body = classNode.childForFieldName('body')
    ?? classNode.children.find(c => c.type === 'class_body' || c.type === 'statement_block');
  if (!body) return symbols;

  for (const member of body.namedChildren) {
    const memberKind = classifyMemberKind(member.type);
    if (!memberKind) continue;

    symbols.push(
      buildSymbol(member, filePath, language, lines, memberKind, classIsExported, className)
    );
  }

  return symbols;
}

/* ── Node classification ──────────────────────────────────────────── */

/** Classify a top-level node type into a SymbolKind, or null if not symbol-worthy. */
function classifyKind(nodeType: string): SymbolKind | null {
  if (nodeType.includes('function') || nodeType === 'arrow_function') return 'function';
  if (nodeType.includes('class_declaration') || nodeType === 'class') return 'class';
  if (nodeType.includes('interface')) return 'interface';
  if (nodeType.includes('enum')) return 'enum';
  if (nodeType.includes('type_alias')) return 'type';
  // Variable declarations (const/let/var with function expressions)
  if (nodeType === 'lexical_declaration' || nodeType === 'variable_declaration') return 'variable';
  // Python
  if (nodeType === 'class_definition') return 'class';
  if (nodeType === 'function_definition' || nodeType === 'decorated_definition') return 'function';
  // Go
  if (nodeType === 'type_declaration') return 'type';
  // Rust
  if (nodeType === 'struct_item') return 'type';
  if (nodeType === 'enum_item') return 'enum';
  if (nodeType === 'trait_item') return 'interface';
  if (nodeType === 'impl_item') return 'class';
  return null;
}

/** Classify a class member node type into a SymbolKind. */
function classifyMemberKind(nodeType: string): SymbolKind | null {
  if (nodeType === 'method_definition' || nodeType === 'method_declaration') return 'method';
  if (nodeType === 'public_field_definition' || nodeType === 'field_definition') return 'variable';
  if (nodeType === 'property_declaration') return 'variable';
  // Python class methods
  if (nodeType === 'function_definition' || nodeType === 'decorated_definition') return 'method';
  return null;
}

/** Check if a variable declaration contains a function/arrow expression (worth indexing). */
function containsFunctionExpression(node: Parser.SyntaxNode): boolean {
  for (const child of node.namedChildren) {
    if (child.type === 'arrow_function' || child.type === 'function_expression'
        || child.type === 'function') return true;
    // Check inside variable_declarator
    if (child.type === 'variable_declarator') {
      for (const gc of child.namedChildren) {
        if (gc.type === 'arrow_function' || gc.type === 'function_expression'
            || gc.type === 'function') return true;
      }
    }
  }
  return false;
}

/* ── Export detection ─────────────────────────────────────────────── */

function isExportNode(node: Parser.SyntaxNode): boolean {
  return node.type === 'export_statement' || node.type === 'export_declaration';
}

/** Unwrap export_statement to get the actual declaration inside. */
function getExportedDeclaration(exportNode: Parser.SyntaxNode): Parser.SyntaxNode | null {
  // export_statement → declaration child (function_declaration, class_declaration, etc.)
  for (const child of exportNode.namedChildren) {
    if (child.type !== 'string' && child.type !== 'export_clause') {
      return child;
    }
  }
  return null;
}

/* ── Name extraction ──────────────────────────────────────────────── */

function extractName(node: Parser.SyntaxNode): string | null {
  // Try field-based access first (most reliable)
  const nameNode = node.childForFieldName('name')
    ?? node.childForFieldName('declarator');

  if (nameNode) {
    // For variable_declarator, get the identifier inside
    if (nameNode.type === 'variable_declarator') {
      return nameNode.childForFieldName('name')?.text ?? nameNode.namedChildren[0]?.text ?? null;
    }
    return nameNode.text;
  }

  // Fallback: first identifier child
  for (const child of node.children) {
    if (child.type === 'identifier' || child.type === 'property_identifier'
        || child.type === 'type_identifier') {
      return child.text;
    }
  }

  return null;
}

/* ── Parameter extraction ─────────────────────────────────────────── */

function extractParameters(node: Parser.SyntaxNode): ParameterInfo[] | undefined {
  // Find formal_parameters or parameters node
  const paramsNode = node.childForFieldName('parameters')
    ?? node.children.find(c =>
      c.type === 'formal_parameters'
      || c.type === 'parameters'
      || c.type === 'parameter_list'
    );

  if (!paramsNode) return undefined;

  const params: ParameterInfo[] = [];
  for (const param of paramsNode.namedChildren) {
    const info = parseParam(param);
    if (info) params.push(info);
  }

  return params.length > 0 ? params : undefined;
}

function parseParam(param: Parser.SyntaxNode): ParameterInfo | null {
  // TS/JS: required_parameter, optional_parameter
  // Python: identifier, typed_parameter, default_parameter
  const nameNode = param.childForFieldName('pattern')
    ?? param.childForFieldName('name')
    ?? param.namedChildren.find(c => c.type === 'identifier');

  if (!nameNode) return null;

  const name = nameNode.text;
  if (!name || name === 'self' || name === 'this') return null;

  // Extract type annotation if present
  const typeNode = param.childForFieldName('type')
    ?? param.children.find(c => c.type === 'type_annotation');
  const type = typeNode?.text?.replace(/^:\s*/, '');

  // Extract default value
  const valueNode = param.childForFieldName('value');
  const defaultValue = valueNode?.text;

  return { name, type, defaultValue };
}

/* ── Return type extraction ───────────────────────────────────────── */

function extractReturnType(node: Parser.SyntaxNode): string | undefined {
  // TS/JS: return_type field or type_annotation after params
  const returnNode = node.childForFieldName('return_type')
    ?? node.children.find(c => c.type === 'type_annotation' || c.type === 'return_type');

  if (!returnNode) return undefined;

  return returnNode.text.replace(/^:\s*/, '').trim() || undefined;
}
