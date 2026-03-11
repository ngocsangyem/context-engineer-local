/**
 * Keyword search using ripgrep (rg) subprocess.
 * Falls back to grep -rn if rg is unavailable.
 * Uses execFile to avoid shell injection.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import type { SearchResult } from './semantic-search.js';

const execFileAsync = promisify(execFile);

/** Parsed ripgrep JSON line for a match */
interface RgMatch {
  type: 'match';
  data: {
    path: { text: string };
    line_number: number;
    lines: { text: string };
    submatches: Array<{ match: { text: string }; start: number; end: number }>;
  };
}

/** Group of matches for a single file */
interface FileMatches {
  filePath: string;
  lines: Array<{ lineNumber: number; text: string }>;
}

/**
 * Parse ripgrep --json output into per-file groups.
 */
function parseRgOutput(stdout: string): FileMatches[] {
  const fileMap = new Map<string, FileMatches>();

  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as { type: string; data: unknown };
      if (parsed.type !== 'match') continue;
      const match = parsed as RgMatch;
      const filePath = match.data.path.text;
      if (!fileMap.has(filePath)) {
        fileMap.set(filePath, { filePath, lines: [] });
      }
      fileMap.get(filePath)!.lines.push({
        lineNumber: match.data.line_number,
        text: match.data.lines.text.trimEnd(),
      });
    } catch {
      // skip malformed lines
    }
  }

  return [...fileMap.values()];
}

/**
 * Run ripgrep and return stdout string.
 * Returns empty string if rg is not found (caller handles fallback).
 */
async function runRipgrep(
  query: string,
  rootPath: string,
  filePattern?: string
): Promise<string> {
  const args = ['--json', '--max-count', '5'];
  if (filePattern) args.push('--glob', filePattern);
  args.push(query, rootPath);

  try {
    const { stdout } = await execFileAsync('rg', args, { maxBuffer: 10 * 1024 * 1024 });
    return stdout;
  } catch (err: unknown) {
    // rg exits with code 1 when no matches — stdout still has content
    if (err && typeof err === 'object' && 'stdout' in err) {
      return (err as { stdout: string }).stdout ?? '';
    }
    throw err;
  }
}

/**
 * Fallback: plain grep -rn when rg is unavailable.
 * Limited: no JSON, no per-match context, max-count not easily enforced.
 */
async function runGrepFallback(
  query: string,
  rootPath: string,
  filePattern?: string
): Promise<FileMatches[]> {
  const args = ['-rn', '--include', filePattern ?? '*', query, rootPath];
  try {
    const { stdout } = await execFileAsync('grep', args, { maxBuffer: 5 * 1024 * 1024 });
    const fileMap = new Map<string, FileMatches>();
    for (const line of stdout.split('\n')) {
      const match = line.match(/^(.+?):(\d+):(.*)$/);
      if (!match) continue;
      const [, filePath, lineNum, text] = match;
      if (!fileMap.has(filePath)) fileMap.set(filePath, { filePath, lines: [] });
      fileMap.get(filePath)!.lines.push({ lineNumber: parseInt(lineNum, 10), text });
    }
    return [...fileMap.values()];
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'stdout' in err) {
      // grep exit code 1 = no matches
      return [];
    }
    return [];
  }
}

/**
 * Map per-file match groups to SearchResult objects.
 * Score is 1.0 for the first match in a file, lower for subsequent files.
 */
function mapToResults(matches: FileMatches[], limit: number): SearchResult[] {
  const results: SearchResult[] = [];

  for (let i = 0; i < Math.min(matches.length, limit); i++) {
    const { filePath, lines } = matches[i];
    if (lines.length === 0) continue;

    const firstLine = lines[0].lineNumber;
    const lastLine = lines[lines.length - 1].lineNumber;
    const content = lines.map((l) => `${l.lineNumber}: ${l.text}`).join('\n');
    // Score decreases slightly per file rank, exact matches score 1.0
    const score = Math.max(0.1, 1.0 - i * 0.05);

    results.push({
      filePath,
      content,
      score,
      startLine: firstLine,
      endLine: lastLine,
      chunkName: path.basename(filePath),
      source: 'keyword' as const,
    });
  }

  return results;
}

/**
 * Search for query string across codebase using ripgrep (or grep fallback).
 * @param query Literal search string
 * @param rootPath Root directory to search in
 * @param limit Maximum number of file results
 * @param filePattern Optional glob pattern (e.g. "*.ts")
 */
export async function keywordSearch(
  query: string,
  rootPath: string,
  limit: number,
  filePattern?: string
): Promise<SearchResult[]> {
  try {
    const stdout = await runRipgrep(query, rootPath, filePattern);
    const matches = parseRgOutput(stdout);
    return mapToResults(matches, limit);
  } catch (rgErr: unknown) {
    // rg not found — try grep fallback
    const isNotFound =
      rgErr instanceof Error && rgErr.message.includes('ENOENT');
    if (isNotFound) {
      const matches = await runGrepFallback(query, rootPath, filePattern);
      return mapToResults(matches, limit);
    }
    process.stderr.write(`KeywordSearch error: ${rgErr}\n`);
    return [];
  }
}
