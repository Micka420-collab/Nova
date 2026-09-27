// Review model (POWER_UX §4.2): ordered files and hunks, a cursor and a decision per hunk. Pure, so
// the keyboard map and the decisions sent to main are testable without a DOM.
import type { ReviewDecision, ReviewDecisionKind } from "@nova/shared";

export type HunkDecision = "pending" | "kept" | "reverted";

export interface ReviewFileShape {
  path: string;
  /** 0 = no hunk to show (binary, no git, no textual change): decided at file level. */
  hunks: number;
}

export interface ReviewState {
  files: ReviewFileShape[];
  /** Decisions by path: one per hunk, or a single file-level entry when the file has no hunk. */
  decisions: Record<string, HunkDecision[]>;
  cursor: { file: number; hunk: number };
  sideBySide: boolean;
  /** Files whose Créer summary is folded open to show hunks. */
  expanded: Record<string, boolean>;
}

export type ReviewAction =
  | { type: "next" }
  | { type: "previous" }
  | { type: "nextFile" }
  | { type: "previousFile" }
  | { type: "decide"; decision: HunkDecision }
  | { type: "decideAt"; path: string; hunk: number; decision: HunkDecision }
  | { type: "decideFile"; path: string; decision: HunkDecision }
  | { type: "focus"; file: number; hunk: number }
  | { type: "toggleSideBySide" }
  | { type: "toggleExpanded"; path: string }
  | { type: "reset"; files: ReviewFileShape[] };

function slots(file: ReviewFileShape): number {
  return Math.max(1, file.hunks);
}

export function initialReview(files: ReviewFileShape[]): ReviewState {
  return {
    files,
    decisions: Object.fromEntries(files.map((file) => [file.path, Array.from({ length: slots(file) }, () => "pending" as const)])),
    cursor: { file: 0, hunk: 0 },
    sideBySide: false,
    expanded: {},
  };
}

function setDecision(state: ReviewState, path: string, hunk: number, decision: HunkDecision): ReviewState {
  const current = state.decisions[path];
  if (!current || hunk < 0 || hunk >= current.length) return state;
  const next = current.map((value, index) => (index === hunk ? decision : value));
  return { ...state, decisions: { ...state.decisions, [path]: next } };
}

function move(state: ReviewState, step: 1 | -1): ReviewState {
  const { file, hunk } = state.cursor;
  const current = state.files[file];
  if (!current) return state;
  const nextHunk = hunk + step;
  if (nextHunk >= 0 && nextHunk < slots(current)) return { ...state, cursor: { file, hunk: nextHunk } };
  const nextFile = state.files[file + step];
  if (!nextFile) return state;
  return { ...state, cursor: { file: file + step, hunk: step === 1 ? 0 : slots(nextFile) - 1 } };
}

export function reviewReducer(state: ReviewState, action: ReviewAction): ReviewState {
  switch (action.type) {
    case "next":
      return move(state, 1);
    case "previous":
      return move(state, -1);
    case "nextFile":
      return state.cursor.file + 1 < state.files.length ? { ...state, cursor: { file: state.cursor.file + 1, hunk: 0 } } : state;
    case "previousFile":
      return state.cursor.file > 0 ? { ...state, cursor: { file: state.cursor.file - 1, hunk: 0 } } : state;
    case "decide": {
      const file = state.files[state.cursor.file];
      return file ? setDecision(state, file.path, state.cursor.hunk, action.decision) : state;
    }
    case "decideAt":
      return setDecision(state, action.path, action.hunk, action.decision);
    case "decideFile": {
      const current = state.decisions[action.path];
      if (!current) return state;
      return { ...state, decisions: { ...state.decisions, [action.path]: current.map(() => action.decision) } };
    }
    case "focus":
      return state.files[action.file] ? { ...state, cursor: { file: action.file, hunk: action.hunk } } : state;
    case "toggleSideBySide":
      return { ...state, sideBySide: !state.sideBySide };
    case "toggleExpanded":
      return { ...state, expanded: { ...state.expanded, [action.path]: !state.expanded[action.path] } };
    case "reset":
      return initialReview(action.files);
  }
}

/** Keyboard map of the review region (single keys: active only while the region has focus). */
export type ReviewKeyResult =
  | { kind: "action"; action: ReviewAction }
  | { kind: "open" }
  | { kind: "summary" }
  | { kind: "leave" }
  | null;

export function reviewKey(event: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean }): ReviewKeyResult {
  if (event.ctrlKey || event.metaKey || event.altKey) return null;
  switch (event.key) {
    case "j":
    case "n":
    case "ArrowDown":
      return { kind: "action", action: { type: "next" } };
    case "k":
    case "p":
    case "ArrowUp":
      return { kind: "action", action: { type: "previous" } };
    case "J":
      return { kind: "action", action: { type: "nextFile" } };
    case "K":
      return { kind: "action", action: { type: "previousFile" } };
    case "a":
      return { kind: "action", action: { type: "decide", decision: "kept" } };
    case "x":
    case "r":
      return { kind: "action", action: { type: "decide", decision: "reverted" } };
    case "u":
      return { kind: "action", action: { type: "toggleSideBySide" } };
    case "o":
      return { kind: "open" };
    case "s":
      return { kind: "summary" };
    case "Escape":
      return { kind: "leave" };
    default:
      return null;
  }
}

/** Some hunks are still pending while others are decided. */
export function hasPendingMix(state: ReviewState): boolean {
  const all = Object.values(state.decisions).flat();
  return all.some((value) => value === "pending") && all.some((value) => value !== "pending");
}

export function decidedCount(state: ReviewState): number {
  return Object.values(state.decisions)
    .flat()
    .filter((value) => value !== "pending").length;
}

/**
 * Decisions to send to main. A file whose every hunk got the same decision is sent as ONE
 * file-level decision (`hunkIndex: null`): same effect, and it does not depend on main indexing the
 * hunks exactly like `git diff`. Otherwise each decided hunk is sent with its index; pending hunks
 * are not sent. `only` restricts to one kind (e.g. "keep the accepted blocks, drop the rest").
 */
export function toReviewDecisions(state: ReviewState, only?: ReviewDecisionKind): ReviewDecision[] {
  const out: ReviewDecision[] = [];
  for (const file of state.files) {
    const values = state.decisions[file.path] ?? [];
    const first = values[0];
    const uniform = first !== undefined && first !== "pending" && values.every((value) => value === first);
    if (uniform) {
      if (!only || only === first) out.push({ path: file.path, hunkIndex: null, decision: first });
      continue;
    }
    values.forEach((value, index) => {
      if (value === "pending") return;
      if (only && only !== value) return;
      out.push({ path: file.path, hunkIndex: file.hunks === 0 ? null : index, decision: value });
    });
  }
  return out;
}

/** "2 sur 3 gardés": counts for a file's pill. */
export function fileTally(state: ReviewState, path: string): { kept: number; reverted: number; total: number } {
  const values = state.decisions[path] ?? [];
  return {
    kept: values.filter((value) => value === "kept").length,
    reverted: values.filter((value) => value === "reverted").length,
    total: values.length,
  };
}
