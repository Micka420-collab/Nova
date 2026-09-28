// Pure helpers of the project search panel: grouping ripgrep matches by file and replacing with the
// same semantics as the search (literal / regex, case, whole word) on the renderer side.
import type { SearchMatch } from "@nova/shared";

export interface MatchGroup {
  path: string;
  matches: SearchMatch[];
}

/** Groups matches by file, keeping the order in which files first appear. */
export function groupMatches(matches: readonly SearchMatch[]): MatchGroup[] {
  const groups = new Map<string, SearchMatch[]>();
  for (const match of matches) {
    const list = groups.get(match.path);
    if (list) list.push(match);
    else groups.set(match.path, [match]);
  }
  return [...groups].map(([path, list]) => ({ path, matches: list }));
}

export interface SearchOptions {
  pattern: string;
  isRegex: boolean;
  caseSensitive: boolean;
  wholeWord: boolean;
}

export type RegExpResult = { ok: true; regex: RegExp } | { ok: false; error: string };

/** Escapes syntax characters only: under the `u` flag, escaping anything else is an error. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

/**
 * ripgrep's `\w` (Unicode, UTS #18): `--word-regexp` needs a non-word character or a line edge on
 * each side. JavaScript's ASCII `\b` would treat « é » as a boundary: `caf` would match « café ».
 */
const WORD_CHAR = String.raw`[\p{Alphabetic}\p{M}\p{Nd}\p{Pc}\p{Join_Control}]`;

/**
 * JavaScript equivalent of the ripgrep query. `m`: ^ and $ match at line boundaries, as ripgrep is
 * line-oriented; `u`: Unicode classes and word boundaries, as ripgrep's default. Dialects still
 * differ at the edges, so a file whose match count differs from the preview is not rewritten.
 */
export function buildSearchRegExp(query: SearchOptions): RegExpResult {
  const source = query.isRegex ? query.pattern : escapeRegExp(query.pattern);
  const wrapped = query.wholeWord ? `(?<!${WORD_CHAR})(?:${source})(?!${WORD_CHAR})` : source;
  try {
    return { ok: true, regex: new RegExp(wrapped, query.caseSensitive ? "gmu" : "gimu") };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Replaces every match; a literal replacement never interprets `$1`, `$&`… sequences. */
export function replaceInText(
  text: string,
  regex: RegExp,
  replacement: string,
  isRegex: boolean,
): { text: string; count: number } {
  const global = regex.global ? regex : new RegExp(regex.source, `${regex.flags}g`);
  // An empty match (a lone `^`) replaced by nothing changes nothing: it is not a replacement.
  const count = [...text.matchAll(global)].filter((match) => match[0] !== "" || replacement !== "").length;
  if (count === 0) return { text, count };
  // Regex mode expands `$1`, `$&`, `$<name>` like String.prototype.replace; literal mode never does.
  const result = isRegex ? text.replace(global, replacement) : text.replace(global, () => replacement);
  return { text: result, count };
}

/** The line as it will read after replacing (for the preview). */
export function previewLine(lineText: string, regex: RegExp, replacement: string, isRegex: boolean): string {
  return replaceInText(lineText, regex, replacement, isRegex).text;
}

/** "src/**, *.ts" → ["src/**", "*.ts"]. */
export function parseGlobList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "")
    .slice(0, 50);
}
