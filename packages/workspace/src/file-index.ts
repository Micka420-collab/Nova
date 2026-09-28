// Quick-open file index (E10) and glob listing (A2): every non-ignored file of the workspace,
// walked once, then kept current from watcher batches. Symlinks are not followed (no cycles, no
// escape); links to files inside the root are indexed under their own path.
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { joinRelativePath, type FileChange, type FileSearchResult, type RelativePath } from "@nova/shared";
import { classifySymlink } from "./confine";
import type { IgnoreMatcher } from "./ignore-rules";

/** Walk bound: beyond it the index is marked incomplete rather than exhausting memory. */
export const FILE_INDEX_MAX = 200_000;

export interface WalkResult {
  files: RelativePath[];
  complete: boolean;
}

export async function walkFiles(
  root: string,
  matcher: IgnoreMatcher,
  options: { max?: number; signal?: AbortSignal } = {},
): Promise<WalkResult> {
  const max = options.max ?? FILE_INDEX_MAX;
  const files: RelativePath[] = [];
  const queue: RelativePath[] = [""];
  while (queue.length > 0) {
    if (options.signal?.aborted) return { files, complete: false };
    const dir = queue.shift() as RelativePath;
    await matcher.load(dir);
    const absoluteDir = dir === "" ? root : join(root, ...dir.split("/"));
    let entries;
    try {
      entries = await readdir(absoluteDir, { withFileTypes: true });
    } catch {
      continue; // unreadable folder: skipped, not fatal
    }
    for (const entry of entries) {
      const path = joinRelativePath(dir, entry.name);
      if (entry.isDirectory()) {
        if (!matcher.isIgnored(path, true)) queue.push(path);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        if (entry.isSymbolicLink()) {
          const link = await classifySymlink(root, join(absoluteDir, entry.name));
          if (link.outsideWorkspace || link.targetIsDirectory) continue;
        }
        if (matcher.isIgnored(path, false)) continue;
        files.push(path);
        if (files.length >= max) return { files, complete: false };
      }
    }
  }
  return { files, complete: true };
}

// ---------------------------------------------------------------------------
// Fuzzy scoring: case-insensitive subsequence match; bonuses for matches at word starts, runs of
// consecutive characters and matches inside the file name; shorter paths win ties.

function isBoundary(text: string, index: number): boolean {
  if (index === 0) return true;
  const previous = text[index - 1] as string;
  if ("/\\._- ".includes(previous)) return true;
  const current = text[index] as string;
  return previous === previous.toLowerCase() && current !== current.toLowerCase();
}

function scoreIn(text: string, query: string, offset: number): number | null {
  const lower = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  let score = 0;
  let from = offset;
  let previous = -2;
  for (let q = 0; q < lowerQuery.length; q += 1) {
    const char = lowerQuery[q] as string;
    let index = lower.indexOf(char, from);
    if (index === -1) return null;
    // Prefer a word-start occurrence when one exists shortly after the greedy hit.
    const boundaryHit = findBoundary(text, lower, char, index, Math.min(lower.length, index + 16));
    if (boundaryHit !== -1 && index !== previous + 1 && isSubsequence(lower, lowerQuery, q + 1, boundaryHit + 1)) {
      index = boundaryHit;
    }
    score += 1;
    if (index === previous + 1) score += 5;
    if (isBoundary(text, index)) score += 8;
    if (text[index] === query[q]) score += 1;
    score -= Math.min(3, index - previous - 1) * 0.5;
    previous = index;
    from = index + 1;
  }
  return score;
}

function isSubsequence(text: string, query: string, fromQuery: number, fromText: number): boolean {
  let at = fromText;
  for (let q = fromQuery; q < query.length; q += 1) {
    at = text.indexOf(query[q] as string, at);
    if (at === -1) return false;
    at += 1;
  }
  return true;
}

function findBoundary(text: string, lower: string, char: string, from: number, to: number): number {
  for (let index = from; index < to; index += 1) if (lower[index] === char && isBoundary(text, index)) return index;
  return -1;
}

/** Score of `path` for `query`, null when the query is not a subsequence of the path. */
export function fuzzyScore(path: RelativePath, query: string): number | null {
  const needle = query.replace(/\s+/g, "");
  if (needle === "") return 0;
  const nameStart = path.lastIndexOf("/") + 1;
  const whole = scoreIn(path, needle, 0);
  if (whole === null) return null;
  const inName = scoreIn(path, needle, nameStart);
  const best = inName === null ? whole : Math.max(whole, inName + 10);
  return best - path.length * 0.01;
}

export function rankPaths(paths: Iterable<RelativePath>, query: string, limit: number): FileSearchResult {
  const scored: { path: RelativePath; score: number }[] = [];
  for (const path of paths) {
    const score = fuzzyScore(path, query);
    if (score !== null) scored.push({ path, score });
  }
  scored.sort((a, b) => b.score - a.score || a.path.length - b.path.length || (a.path < b.path ? -1 : 1));
  return { paths: scored.slice(0, limit).map((entry) => entry.path), truncated: scored.length > limit };
}

/** Index kept in the fs-worker: built lazily, patched from watcher changes. */
export class FileIndex {
  private readonly files = new Set<RelativePath>();
  private building: Promise<void> | null = null;
  private completeValue = false;

  constructor(
    private readonly root: string,
    private readonly matcher: IgnoreMatcher,
  ) {}

  get complete(): boolean {
    return this.completeValue;
  }

  /** Builds the index on first use (concurrent callers share the walk). */
  ensure(): Promise<void> {
    this.building ??= walkFiles(this.root, this.matcher).then((result) => {
      for (const file of result.files) this.files.add(file);
      this.completeValue = result.complete;
    });
    return this.building;
  }

  /** Applies watcher changes (a deleted folder drops everything below it). */
  apply(changes: readonly FileChange[]): void {
    for (const change of changes) {
      if (change.kind === "deleted") {
        this.files.delete(change.path);
        if (change.isDirectory) {
          const prefix = `${change.path}/`;
          for (const file of this.files) if (file.startsWith(prefix)) this.files.delete(file);
        }
      } else if (!change.isDirectory && !this.matcher.isIgnored(change.path, false)) {
        this.files.add(change.path);
      }
    }
  }

  /** Forces a rebuild on next use (after a watcher overflow). */
  reset(): void {
    this.files.clear();
    this.building = null;
    this.completeValue = false;
  }

  async search(query: string, limit: number): Promise<FileSearchResult> {
    await this.ensure();
    return rankPaths(this.files, query, limit);
  }

  async all(): Promise<RelativePath[]> {
    await this.ensure();
    return [...this.files].sort();
  }
}
