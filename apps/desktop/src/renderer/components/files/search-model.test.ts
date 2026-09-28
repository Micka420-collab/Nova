import { describe, expect, it } from "vitest";
import type { SearchMatch } from "@nova/shared";
import { buildSearchRegExp, groupMatches, parseGlobList, previewLine, replaceInText } from "./search-model";

const match = (path: string, line: number): SearchMatch => ({ path, line, lineText: "x", ranges: [{ start: 0, end: 1 }] });

function regexOf(pattern: string, options: Partial<{ isRegex: boolean; caseSensitive: boolean; wholeWord: boolean }> = {}) {
  const result = buildSearchRegExp({ pattern, isRegex: false, caseSensitive: false, wholeWord: false, ...options });
  if (!result.ok) throw new Error(result.error);
  return result.regex;
}

describe("groupMatches", () => {
  it("groups by file in first-seen order", () => {
    const groups = groupMatches([match("b.ts", 1), match("a.ts", 2), match("b.ts", 5)]);
    expect(groups.map((group) => [group.path, group.matches.map((item) => item.line)])).toEqual([
      ["b.ts", [1, 5]],
      ["a.ts", [2]],
    ]);
  });
});

describe("buildSearchRegExp", () => {
  it("escapes literal patterns", () => {
    expect(regexOf("a.b(").test("a.b(")).toBe(true);
    expect(regexOf("a.b").test("axb")).toBe(false);
  });

  it("honors case and whole word", () => {
    expect(regexOf("Todo", { caseSensitive: true }).test("todo")).toBe(false);
    expect(regexOf("todo").test("TODO")).toBe(true);
    expect(regexOf("cat", { wholeWord: true }).test("concat")).toBe(false);
    expect(regexOf("cat", { wholeWord: true }).test("a cat")).toBe(true);
  });

  it("uses Unicode word boundaries for whole word, like ripgrep", () => {
    expect(regexOf("caf", { wholeWord: true }).test("café")).toBe(false);
    expect(regexOf("caf", { wholeWord: true }).test("caf x")).toBe(true);
    expect(regexOf("déjà", { wholeWord: true }).test("c'est déjà fait")).toBe(true);
    expect(regexOf("é", { wholeWord: true, isRegex: true }).test("été")).toBe(false);
    expect(replaceInText("caf x\ncafé", regexOf("caf", { wholeWord: true }), "bar", false)).toEqual({ text: "bar x\ncafé", count: 1 });
    expect(regexOf("a-b").test("a-b")).toBe(true);
  });

  it("reports an invalid regular expression", () => {
    const result = buildSearchRegExp({ pattern: "(", isRegex: true, caseSensitive: false, wholeWord: false });
    expect(result.ok).toBe(false);
  });
});

describe("replaceInText", () => {
  it("replaces every match and counts them", () => {
    expect(replaceInText("a TODO b todo", regexOf("todo"), "done", false)).toEqual({ text: "a done b done", count: 2 });
  });

  it("never expands $ sequences in literal mode", () => {
    expect(replaceInText("x", regexOf("x"), "$&$1", false).text).toBe("$&$1");
  });

  it("expands groups in regex mode", () => {
    expect(replaceInText("foo(1)", regexOf("(\\w+)\\((\\d)\\)", { isRegex: true }), "$2:$1", true).text).toBe("1:foo");
  });

  it("anchors ^ at each line", () => {
    expect(replaceInText("a\nb", regexOf("^", { isRegex: true }), "> ", true).text).toBe("> a\n> b");
  });

  it("previews one line", () => {
    expect(previewLine("let a = 1", regexOf("a", { wholeWord: true }), "b", false)).toBe("let b = 1");
  });
});

describe("parseGlobList", () => {
  it("splits comma-separated globs", () => {
    expect(parseGlobList(" src/**, *.ts ,, ")).toEqual(["src/**", "*.ts"]);
  });
});
