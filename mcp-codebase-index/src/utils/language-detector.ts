/**
 * Maps file extensions to tree-sitter language grammar names.
 * Returns null for unsupported file types.
 */

// Map of file extension (without dot) to tree-sitter language identifier
const EXTENSION_TO_LANGUAGE: Record<string, string> = {
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  jsx: 'jsx',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  go: 'go',
  rs: 'rust',
  java: 'java',
  c: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  h: 'c',
  hpp: 'cpp',
  hxx: 'cpp',
  cs: 'c_sharp',
  rb: 'ruby',
  php: 'php',
  swift: 'swift',
  kt: 'kotlin',
  kts: 'kotlin',
  vue: 'vue'
};

// Binary and non-code extensions to skip
const BINARY_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'bmp', 'ico', 'svg', 'webp',
  'mp3', 'mp4', 'wav', 'avi', 'mov', 'mkv',
  'zip', 'tar', 'gz', 'bz2', 'xz', '7z', 'rar',
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  'exe', 'dll', 'so', 'dylib', 'bin', 'o', 'a',
  'wasm', 'class', 'jar', 'war',
  'ttf', 'otf', 'woff', 'woff2', 'eot',
  'db', 'sqlite', 'sqlite3',
]);

/**
 * Detect the tree-sitter language name for a given file extension.
 * @param extension File extension without the leading dot
 * @returns Language name or null if unsupported
 */
export function detectLanguage(extension: string): string | null {
  const ext = extension.toLowerCase().replace(/^\./, '');
  return EXTENSION_TO_LANGUAGE[ext] ?? null;
}

/**
 * Check if a file extension represents a binary file.
 * @param extension File extension without the leading dot
 * @returns true if binary (should be skipped)
 */
export function isBinaryExtension(extension: string): boolean {
  const ext = extension.toLowerCase().replace(/^\./, '');
  return BINARY_EXTENSIONS.has(ext);
}

/**
 * Get all supported language names.
 */
export function getSupportedLanguages(): string[] {
  return [...new Set(Object.values(EXTENSION_TO_LANGUAGE))];
}

/**
 * Get all supported file extensions.
 */
export function getSupportedExtensions(): string[] {
  return Object.keys(EXTENSION_TO_LANGUAGE);
}
