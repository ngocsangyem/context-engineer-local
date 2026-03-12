/**
 * Parse import/require statements from an AST root node.
 * Extracts raw import source paths and imported symbol names per language.
 * Returns RawImport[] for downstream resolution to absolute file paths.
 */

import type Parser from 'web-tree-sitter';

export interface RawImport {
  /** The raw import path string as written in the source (e.g. './foo', '../bar/baz') */
  sourcePath: string;
  /** Imported symbol names; ['*'] for namespace/side-effect imports */
  symbols: string[];
  /** Line number (1-based) of the import statement */
  line: number;
}

/**
 * Parse all import statements from an AST root node.
 * Dispatches to language-specific parsers.
 */
export function parseImports(root: Parser.SyntaxNode, language: string): RawImport[] {
  switch (language) {
    case 'typescript':
    case 'tsx':
    case 'javascript':
    case 'jsx':
      return parseTsJsImports(root);
    case 'python':
      return parsePythonImports(root);
    default:
      return [];
  }
}

/* ── TypeScript / JavaScript ──────────────────────────────────────── */

/**
 * Parse TS/JS import statements and require() calls.
 * Handles:
 *   import { X, Y } from './file'
 *   import X from './file'
 *   import * as ns from './file'
 *   import './file'  (side-effect)
 *   const x = require('./file')
 */
function parseTsJsImports(root: Parser.SyntaxNode): RawImport[] {
  const imports: RawImport[] = [];

  for (const node of root.children) {
    if (node.type === 'import_statement') {
      const imp = parseTsImportStatement(node);
      if (imp) imports.push(imp);
    } else if (node.type === 'expression_statement') {
      // Top-level require() calls: require('./foo')
      const imp = parseTsRequireCall(node);
      if (imp) imports.push(imp);
    } else if (node.type === 'lexical_declaration' || node.type === 'variable_declaration') {
      // const x = require('./foo')
      const imp = parseTsRequireDeclaration(node);
      if (imp) imports.push(imp);
    }
  }

  return imports;
}

function parseTsImportStatement(node: Parser.SyntaxNode): RawImport | null {
  // Find the string literal (module specifier) — last string child
  const sourceNode = findStringLiteral(node);
  if (!sourceNode) return null;

  const sourcePath = stripQuotes(sourceNode.text);
  const symbols = extractTsImportedSymbols(node);
  return { sourcePath, symbols, line: node.startPosition.row + 1 };
}

/** Extract symbol names from a TS import statement's import clause. */
function extractTsImportedSymbols(node: Parser.SyntaxNode): string[] {
  const symbols: string[] = [];

  for (const child of node.namedChildren) {
    if (child.type === 'import_clause') {
      // Default import: `import Foo from './file'`
      const defaultId = child.childForFieldName('name');
      if (defaultId) symbols.push('default');

      for (const clauseChild of child.namedChildren) {
        if (clauseChild.type === 'namespace_import') {
          // import * as ns
          symbols.push('*');
        } else if (clauseChild.type === 'named_imports') {
          // import { X, Y as Z }
          for (const spec of clauseChild.namedChildren) {
            if (spec.type === 'import_specifier') {
              const name = spec.childForFieldName('name') ?? spec.namedChildren[0];
              if (name) symbols.push(name.text);
            }
          }
        }
      }
    }
  }

  // Side-effect import: `import './file'`
  if (symbols.length === 0) symbols.push('*');
  return symbols;
}

function parseTsRequireCall(node: Parser.SyntaxNode): RawImport | null {
  const callNode = node.firstNamedChild;
  if (!callNode || callNode.type !== 'call_expression') return null;
  return extractRequireFromCall(callNode);
}

function parseTsRequireDeclaration(node: Parser.SyntaxNode): RawImport | null {
  for (const child of node.namedChildren) {
    if (child.type === 'variable_declarator') {
      const value = child.childForFieldName('value');
      if (value?.type === 'call_expression') {
        return extractRequireFromCall(value);
      }
    }
  }
  return null;
}

function extractRequireFromCall(callNode: Parser.SyntaxNode): RawImport | null {
  const fn = callNode.childForFieldName('function');
  if (!fn || fn.text !== 'require') return null;
  const args = callNode.childForFieldName('arguments');
  if (!args) return null;
  const strNode = findStringLiteral(args);
  if (!strNode) return null;
  const sourcePath = stripQuotes(strNode.text);
  return { sourcePath, symbols: ['*'], line: callNode.startPosition.row + 1 };
}

/* ── Python ───────────────────────────────────────────────────────── */

/**
 * Parse Python import statements:
 *   from .module import X, Y
 *   from module import X
 *   import module  (skipped — only relative paths create edges)
 */
function parsePythonImports(root: Parser.SyntaxNode): RawImport[] {
  const imports: RawImport[] = [];

  for (const node of root.children) {
    if (node.type === 'import_from_statement') {
      const imp = parsePythonFromImport(node);
      if (imp) imports.push(imp);
    }
    // Plain `import module` — skip; cannot resolve without sys.path
  }

  return imports;
}

function parsePythonFromImport(node: Parser.SyntaxNode): RawImport | null {
  // from_import: "from" module_name "import" ...
  // module_name may have leading dots for relative imports
  let moduleName = '';
  const symbols: string[] = [];

  for (const child of node.children) {
    if (child.type === 'relative_import' || child.type === 'dotted_name' || child.type === 'identifier') {
      if (!moduleName && child.type !== 'identifier') {
        moduleName = child.text;
      }
    } else if (child.type === 'import_from_statement') {
      // nested — skip
    }
  }

  // Fallback: collect named children for module and symbols
  const namedChildren = node.namedChildren;
  if (namedChildren.length >= 1) {
    moduleName = namedChildren[0].text;
    for (let i = 1; i < namedChildren.length; i++) {
      symbols.push(namedChildren[i].text);
    }
  }

  if (!moduleName) return null;
  // Only relative imports are resolvable (start with dot)
  if (!moduleName.startsWith('.')) return null;

  // Convert Python dotted path to file path-like form
  const sourcePath = moduleName.replace(/\./g, '/').replace(/^\/+/, './');
  return { sourcePath, symbols: symbols.length > 0 ? symbols : ['*'], line: node.startPosition.row + 1 };
}

/* ── Utilities ────────────────────────────────────────────────────── */

/** Find the first string literal node in a subtree. */
function findStringLiteral(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
  for (const child of node.children) {
    if (child.type === 'string' || child.type === 'template_string') return child;
    // Tree-sitter sometimes uses these node types for module specifiers
    if (child.type === '"' || child.type === "'") continue;
  }
  // Search named children for string content
  for (const child of node.namedChildren) {
    if (child.type === 'string' || child.type === 'template_string') return child;
  }
  return null;
}

/** Strip surrounding quote characters from a string literal text. */
function stripQuotes(text: string): string {
  if ((text.startsWith('"') && text.endsWith('"')) ||
      (text.startsWith("'") && text.endsWith("'")) ||
      (text.startsWith('`') && text.endsWith('`'))) {
    return text.slice(1, -1);
  }
  return text;
}
