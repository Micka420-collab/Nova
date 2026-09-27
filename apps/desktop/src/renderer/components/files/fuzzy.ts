// Quick open ranking (POWER_UX 2.5): main returns candidate paths from its file index; the renderer
// re-ranks them so recently opened files come first, then name matches, then path matches.

export interface PathMatch {
  score: number;
  /** Indexes of the matched characters in the path (for highlighting). */
  positions: number[];
}

export interface RankedPath extends PathMatch {
  path: string;
}

const BASENAME_BONUS = 10;
const CONTIGUOUS_BONUS = 8;
const BOUNDARY_BONUS = 6;
const PREFIX_BONUS = 25;
const EXACT_BASENAME_BONUS = 40;
const GAP_PENALTY = 1;
const RECENT_BONUS = 60;
const OPEN_BONUS = 30;

function isBoundary(path: string, index: number): boolean {
  if (index === 0) return true;
  const previous = path[index - 1] ?? "";
  const current = path[index] ?? "";
  if ("/._- ".includes(previous)) return true;
  // camelCase: lower → Upper.
  return previous === previous.toLowerCase() && previous !== previous.toUpperCase() && current !== current.toLowerCase();
}

/** Positions of `query` in `target` as a subsequence, searching from `start`; greedy from the end is not needed here. */
function subsequence(query: string, target: string, start: number): number[] | null {
  const positions: number[] = [];
  let from = start;
  for (const char of query) {
    const index = target.indexOf(char, from);
    if (index < 0) return null;
    positions.push(index);
    from = index + 1;
  }
  return positions;
}

function scorePositions(path: string, positions: number[], baseStart: number): number {
  let score = 0;
  positions.forEach((position, i) => {
    score += 1;
    if (position >= baseStart) score += BASENAME_BONUS;
    if (isBoundary(path, position)) score += BOUNDARY_BONUS;
    const previous = positions[i - 1];
    if (previous !== undefined) {
      if (position === previous + 1) score += CONTIGUOUS_BONUS;
      else score -= GAP_PENALTY * Math.min(position - previous - 1, 10);
    }
  });
  return score;
}

/** Case-insensitive subsequence match; null when `query` is not a subsequence of `path`. */
export function scorePath(query: string, path: string): PathMatch | null {
  const q = query.trim().toLowerCase();
  if (q === "") return { score: 0, positions: [] };
  const lower = path.toLowerCase();
  const baseStart = lower.lastIndexOf("/") + 1;
  const base = lower.slice(baseStart);

  // Candidates: all in the basename first (best), then the whole path.
  const candidates: number[][] = [];
  const inBase = subsequence(q, lower, baseStart);
  if (inBase) candidates.push(inBase);
  // A contiguous occurrence anywhere scores well; try each start of the first character.
  for (let index = lower.indexOf(q); index >= 0; index = lower.indexOf(q, index + 1)) {
    candidates.push(Array.from({ length: q.length }, (_, i) => index + i));
  }
  const anywhere = subsequence(q, lower, 0);
  if (anywhere) candidates.push(anywhere);
  if (candidates.length === 0) return null;

  let best: PathMatch | null = null;
  for (const positions of candidates) {
    let score = scorePositions(path, positions, baseStart);
    if (base.startsWith(q)) score += PREFIX_BONUS;
    if (base === q || base.replace(/\.[^.]*$/, "") === q) score += EXACT_BASENAME_BONUS;
    if (!best || score > best.score) best = { score, positions };
  }
  return best;
}

export interface RankOptions {
  /** Most recently used first. */
  recent?: readonly string[];
  open?: ReadonlySet<string>;
}

export function rankPaths(query: string, paths: readonly string[], options: RankOptions = {}): RankedPath[] {
  const recent = options.recent ?? [];
  const ranked: RankedPath[] = [];
  for (const path of new Set(paths)) {
    const match = scorePath(query, path);
    if (!match) continue;
    let score = match.score;
    const recency = recent.indexOf(path);
    if (recency >= 0) score += RECENT_BONUS - Math.min(recency, 20);
    if (options.open?.has(path)) score += OPEN_BONUS;
    ranked.push({ path, score, positions: match.positions });
  }
  return ranked.sort((a, b) => b.score - a.score || a.path.length - b.path.length || a.path.localeCompare(b.path));
}

export interface QuickOpenQuery {
  text: string;
  /** 1-based. */
  line: number | null;
  /** 1-based. */
  column: number | null;
}

/** `app.ts:42` or `app.ts:42:7` → text + line/column. */
export function parseQuickOpenQuery(query: string): QuickOpenQuery {
  const match = /^(.*?):(\d+)(?::(\d+))?$/.exec(query.trim());
  if (!match) return { text: query.trim(), line: null, column: null };
  const line = Number(match[2]);
  const column = match[3] === undefined ? null : Number(match[3]);
  return { text: (match[1] ?? "").trim(), line: line > 0 ? line : null, column: column && column > 0 ? column : null };
}
