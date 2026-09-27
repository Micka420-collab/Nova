import { describe, expect, it } from "vitest";
import { hasPendingMix, initialReview, reviewKey, reviewReducer, toReviewDecisions, type ReviewState } from "./model";

const FILES = [
  { path: "a.ts", hunks: 2 },
  { path: "b.ts", hunks: 0 },
  { path: "c.ts", hunks: 3 },
];

function press(state: ReviewState, keys: string[]): ReviewState {
  return keys.reduce((current, key) => {
    const result = reviewKey({ key, ctrlKey: false, metaKey: false, altKey: false });
    return result?.kind === "action" ? reviewReducer(current, result.action) : current;
  }, state);
}

describe("review keyboard model", () => {
  it("moves hunk by hunk across files with j/k and file by file with J/K", () => {
    let state = initialReview(FILES);
    state = press(state, ["j"]);
    expect(state.cursor).toEqual({ file: 0, hunk: 1 });
    state = press(state, ["j"]);
    // A file without hunks is one stop (file-level decision).
    expect(state.cursor).toEqual({ file: 1, hunk: 0 });
    state = press(state, ["j", "j", "j", "j"]);
    expect(state.cursor).toEqual({ file: 2, hunk: 2 });
    state = press(state, ["k"]);
    expect(state.cursor).toEqual({ file: 2, hunk: 1 });
    state = press(state, ["K", "K"]);
    expect(state.cursor).toEqual({ file: 0, hunk: 0 });
    state = press(state, ["J"]);
    expect(state.cursor).toEqual({ file: 1, hunk: 0 });
  });

  it("a keeps, x and r revert the current hunk; u toggles side by side", () => {
    let state = initialReview(FILES);
    state = press(state, ["a", "j", "x", "J", "J", "r", "u"]);
    expect(state.decisions["a.ts"]).toEqual(["kept", "reverted"]);
    expect(state.decisions["c.ts"]).toEqual(["reverted", "pending", "pending"]);
    expect(state.sideBySide).toBe(true);
    expect(hasPendingMix(state)).toBe(true);
  });

  it("ignores modified keys (they belong to the app)", () => {
    expect(reviewKey({ key: "a", ctrlKey: true, metaKey: false, altKey: false })).toBeNull();
    expect(reviewKey({ key: "o", ctrlKey: false, metaKey: false, altKey: false })).toEqual({ kind: "open" });
  });
});

describe("toReviewDecisions", () => {
  it("sends decided hunks with their index and skips pending ones", () => {
    const state = press(initialReview(FILES), ["J", "J", "a", "j", "j", "x"]);
    expect(toReviewDecisions(state)).toEqual([
      { path: "c.ts", hunkIndex: 0, decision: "kept" },
      { path: "c.ts", hunkIndex: 2, decision: "reverted" },
    ]);
  });

  it("sends one file-level decision when every hunk of a file got the same one", () => {
    let state = initialReview(FILES);
    state = reviewReducer(state, { type: "decideFile", path: "a.ts", decision: "kept" });
    state = reviewReducer(state, { type: "decideAt", path: "b.ts", hunk: 0, decision: "reverted" });
    expect(toReviewDecisions(state)).toEqual([
      { path: "a.ts", hunkIndex: null, decision: "kept" },
      { path: "b.ts", hunkIndex: null, decision: "reverted" },
    ]);
  });

  it("can keep only the accepted blocks", () => {
    const state = press(initialReview(FILES), ["a", "j", "x"]);
    expect(toReviewDecisions(state, "kept")).toEqual([{ path: "a.ts", hunkIndex: 0, decision: "kept" }]);
  });
});
