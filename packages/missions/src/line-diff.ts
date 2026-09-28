// A11: line diff of a mission's change (content before the mission → content now), grouped in
// unified-diff hunks (3 lines of context), and the per-hunk revert used by the review. Myers'
// O(ND) algorithm on whole lines (line endings included, so CRLF and a missing final newline are
// preserved exactly). Pathological inputs are refused (null) rather than computed slowly: the
// review then offers the whole-file decision only.

export interface LineHunk {
  /** 0-based line index in the old text where the hunk (context included) starts. */
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
}

export const HUNK_CONTEXT_LINES = 3;
/** Bound on the diff's memory: edit distance × (old + new lines) cells. */
const MAX_TRACE_CELLS = 20_000_000;

type Op = { kind: "equal" | "delete" | "insert" };

/** Lines with their terminators ("a\r\n", "b\n", "c"). */
export function splitLines(text: string): string[] {
  return text === "" ? [] : text.split(/(?<=\n)/);
}

function myers(a: readonly string[], b: readonly string[]): Op[] | null {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const offset = max + 1;
  const width = 2 * max + 3;
  const maxD = Math.min(max, Math.floor(MAX_TRACE_CELLS / width));
  const v = new Int32Array(width);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= maxD; d += 1) {
    // Snapshot of the furthest points before step d, for the backtrack.
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      const down = k === -d || (k !== d && (v[k - 1 + offset] ?? 0) < (v[k + 1 + offset] ?? 0));
      let x = down ? (v[k + 1 + offset] ?? 0) : (v[k - 1 + offset] ?? 0) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      v[k + offset] = x;
      if (x >= n && y >= m) return backtrack(trace, n, m, offset);
    }
  }
  return null;
}

function backtrack(trace: readonly Int32Array[], n: number, m: number, offset: number): Op[] {
  const ops: Op[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d -= 1) {
    const v = trace[d] ?? new Int32Array(0);
    const k = x - y;
    const down = k === -d || (k !== d && (v[k - 1 + offset] ?? 0) < (v[k + 1 + offset] ?? 0));
    const prevK = down ? k + 1 : k - 1;
    const prevX = d === 0 ? 0 : (v[prevK + offset] ?? 0);
    const prevY = d === 0 ? 0 : prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ kind: "equal" });
      x -= 1;
      y -= 1;
    }
    if (d > 0) {
      ops.push({ kind: x === prevX ? "insert" : "delete" });
      x = prevX;
      y = prevY;
    }
  }
  return ops.reverse();
}

interface LineDiff {
  a: string[];
  b: string[];
  /** Every line of both texts, in order (prefix and suffix included). */
  ops: Op[];
  hunks: LineHunk[];
}

function lineDiff(before: string, after: string, context: number): LineDiff | null {
  const a = splitLines(before);
  const b = splitLines(after);
  // Common prefix and suffix are cheap to skip and keep the Myers trace small.
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix += 1;
  const middle = myers(a.slice(prefix, a.length - suffix), b.slice(prefix, b.length - suffix));
  if (middle === null) return null;
  const equal = (count: number): Op[] => Array.from({ length: count }, () => ({ kind: "equal" as const }));
  const ops = [...equal(prefix), ...middle, ...equal(suffix)];

  // Change blocks as [aStart, aEnd, bStart, bEnd) in full-text indexes.
  const blocks: [number, number, number, number][] = [];
  let x = 0;
  let y = 0;
  let open: [number, number, number, number] | null = null;
  for (const op of ops) {
    if (op.kind === "equal") {
      if (open) blocks.push(open);
      open = null;
      x += 1;
      y += 1;
      continue;
    }
    open ??= [x, x, y, y];
    if (op.kind === "delete") {
      x += 1;
      open[1] = x;
    } else {
      y += 1;
      open[3] = y;
    }
  }
  if (open) blocks.push(open);

  const hunks: LineHunk[] = [];
  let group: [number, number, number, number][] = [];
  const flush = (): void => {
    const firstBlock = group[0];
    const lastBlock = group.at(-1);
    if (!firstBlock || !lastBlock) return;
    const oldFrom = Math.max(0, firstBlock[0] - context);
    const oldTo = Math.min(a.length, lastBlock[1] + context);
    const newFrom = firstBlock[2] - (firstBlock[0] - oldFrom);
    const newTo = lastBlock[3] + (oldTo - lastBlock[1]);
    hunks.push({ oldStart: oldFrom, oldLines: oldTo - oldFrom, newStart: newFrom, newLines: newTo - newFrom });
    group = [];
  };
  for (const block of blocks) {
    const previous = group.at(-1);
    if (previous && block[0] - previous[1] > 2 * context) flush();
    group.push(block);
  }
  flush();
  return { a, b, ops, hunks };
}

/** Hunks of diff(before → after), in order; null when the diff is too large to compute. */
export function diffHunks(before: string, after: string, context = HUNK_CONTEXT_LINES): LineHunk[] | null {
  return lineDiff(before, after, context)?.hunks ?? null;
}

function patchLine(marker: " " | "-" | "+", line: string): string[] {
  // Line terminators are kept by splitLines: "\n" ends the patch line, "\r" stays in its text.
  if (line.endsWith("\n")) return [`${marker}${line.slice(0, -1)}`];
  return [`${marker}${line}`, "\\ No newline at end of file"];
}

function rangeHeader(start: number, lines: number): string {
  // Unified diff convention: 1-based start; an empty range names the line before it.
  return `${lines === 0 ? start : start + 1},${lines}`;
}

/**
 * Unified patch of diff(before → after) for one file, hunks in `diffHunks` order (so its hunk
 * index is the one `revertHunks` and the review use). `before`/`after` null = absent file.
 * Returns "" when both sides are equal, null when the diff is too large to compute.
 */
export function unifiedPatch(path: string, before: string | null, after: string | null): string | null {
  const diff = lineDiff(before ?? "", after ?? "", HUNK_CONTEXT_LINES);
  if (diff === null) return null;
  if (diff.hunks.length === 0) return "";
  const out = [before === null ? "--- /dev/null" : `--- a/${path}`, after === null ? "+++ /dev/null" : `+++ b/${path}`];
  let x = 0;
  let y = 0;
  let hunkIndex = 0;
  for (const op of diff.ops) {
    const hunk = diff.hunks[hunkIndex];
    if (hunk && x === hunk.oldStart && y === hunk.newStart) {
      out.push(`@@ -${rangeHeader(hunk.oldStart, hunk.oldLines)} +${rangeHeader(hunk.newStart, hunk.newLines)} @@`);
    }
    const inside = hunk !== undefined && x >= hunk.oldStart && y >= hunk.newStart;
    if (op.kind === "equal") {
      if (inside) out.push(...patchLine(" ", diff.a[x] ?? ""));
      x += 1;
      y += 1;
    } else if (op.kind === "delete") {
      if (inside) out.push(...patchLine("-", diff.a[x] ?? ""));
      x += 1;
    } else {
      if (inside) out.push(...patchLine("+", diff.b[y] ?? ""));
      y += 1;
    }
    if (hunk && x >= hunk.oldStart + hunk.oldLines && y >= hunk.newStart + hunk.newLines) hunkIndex += 1;
  }
  return `${out.join("\n")}\n`;
}

/**
 * Undoes the selected hunks of diff(before → current) in `current` (indexes as `diffHunks` lists
 * them). Returns null when a hunk index does not exist or the diff cannot be computed.
 */
export function revertHunks(before: string, current: string, hunkIndexes: readonly number[]): string | null {
  const hunks = diffHunks(before, current);
  if (!hunks) return null;
  const selected = [...new Set(hunkIndexes)].sort((left, right) => right - left);
  if (selected.some((index) => !hunks[index])) return null;
  const a = splitLines(before);
  const b = splitLines(current);
  for (const index of selected) {
    const hunk = hunks[index];
    if (!hunk) return null;
    // Context lines are identical on both sides: swapping the whole hunk range reverts its changes.
    b.splice(hunk.newStart, hunk.newLines, ...a.slice(hunk.oldStart, hunk.oldStart + hunk.oldLines));
  }
  return b.join("");
}
