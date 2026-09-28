import { describe, expect, it } from "vitest";
import { parseQuickOpenQuery, rankPaths, scorePath } from "./fuzzy";

const order = (query: string, paths: string[], recent: string[] = []) =>
  rankPaths(query, paths, { recent }).map((item) => item.path);

describe("scorePath", () => {
  it("returns null when the query is not a subsequence", () => {
    expect(scorePath("xyz", "src/app.ts")).toBeNull();
  });

  it("scores an empty query at zero", () => {
    expect(scorePath("  ", "src/app.ts")).toEqual({ score: 0, positions: [] });
  });

  it("reports matched positions for highlighting", () => {
    expect(scorePath("app", "src/app.ts")?.positions).toEqual([4, 5, 6]);
  });

  it("is case-insensitive", () => {
    expect(scorePath("APP", "src/app.ts")).not.toBeNull();
  });
});

describe("rankPaths", () => {
  it("ranks a basename match above a deep directory match", () => {
    expect(order("app", ["app/deep/other/index.ts", "src/app.ts"])).toEqual(["src/app.ts", "app/deep/other/index.ts"]);
  });

  it("ranks a contiguous match above a scattered one", () => {
    expect(order("form", ["src/f_o_r_m.ts", "src/form.ts"])[0]).toBe("src/form.ts");
  });

  it("ranks word starts above mid-word matches", () => {
    expect(order("cb", ["src/cab.ts", "src/CodeBlock.tsx"])[0]).toBe("src/CodeBlock.tsx");
  });

  it("puts recently opened files first", () => {
    expect(order("app", ["src/app.ts", "lib/app.ts"], ["lib/app.ts"])[0]).toBe("lib/app.ts");
  });

  it("drops non-matching paths and breaks ties by shorter path", () => {
    expect(order("a", ["b.ts", "a/x/a.ts", "a.ts"])).toEqual(["a.ts", "a/x/a.ts"]);
  });
});

describe("parseQuickOpenQuery", () => {
  it("reads a line and a column suffix", () => {
    expect(parseQuickOpenQuery("app.ts:42")).toEqual({ text: "app.ts", line: 42, column: null });
    expect(parseQuickOpenQuery("app.ts:42:7")).toEqual({ text: "app.ts", line: 42, column: 7 });
  });

  it("keeps plain text", () => {
    expect(parseQuickOpenQuery(" app ")).toEqual({ text: "app", line: null, column: null });
  });
});
