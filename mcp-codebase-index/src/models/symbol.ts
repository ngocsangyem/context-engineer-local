/**
 * Rich symbol data model for the symbol index.
 * Replaces flat SymbolTag for structured symbol queries.
 */

export type SymbolKind =
  | 'function'
  | 'class'
  | 'method'
  | 'type'
  | 'interface'
  | 'variable'
  | 'enum';

export interface ParameterInfo {
  name: string;
  type?: string;
  defaultValue?: string;
}

export interface SymbolRecord {
  /** Unique id: "filePath#qualifiedName" */
  id: string;
  name: string;
  qualifiedName: string;
  kind: SymbolKind;
  filePath: string;
  startLine: number;
  endLine: number;
  /** First line or full function signature */
  signature: string;
  /** Parent class/module name for methods */
  parentSymbol?: string;
  visibility: 'exported' | 'internal';
  language: string;
  /** JSON-serialized ParameterInfo[] */
  parameters?: ParameterInfo[];
  returnType?: string;
}
