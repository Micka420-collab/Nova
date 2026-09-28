import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { searchText, toSearchMatch } from "./search";
import { makeTempDir, ripgrepForTests, type TempDir } from "./test-support";

let rgPath: string;
let workspace: TempDir;
const base = { isRegex: false, caseSensitive: false, wholeWord: false, include: [], exclude: [], maxResults: 100 };

beforeAll(async () => {
  rgPath = await ripgrepForTests();
});
beforeEach(async () => {
  workspace = await makeTempDir();
  await workspace.write(".gitignore", "dist/\n");
  await workspace.write("src/a.ts", "// TODO: premier\nconst todo = 1;\n");
  await workspace.write("src/é.ts", "const café = 'TODO après';\n");
  await workspace.write("dist/out.js", "TODO in build output\n");
  await workspace.write(".env", "TODO_SECRET=1\n");
});
afterEach(() => workspace.cleanup());

const sorted = <T extends { path: string; line: number }>(matches: T[]): T[] =>
  [...matches].sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);

describe("ripgrep search", () => {
  it("finds matches with UTF-16 ranges, respecting .gitignore and dropping excluded paths", async () => {
    const streamed: string[] = [];
    const result = await searchText(workspace.path, { ...base, pattern: "TODO", caseSensitive: true }, {
      rgPath,
      isExcluded: (path) => path === ".env",
      onMatches: (matches) => streamed.push(...matches.map((match) => match.path)),
    });
    expect(result.truncated).toBe(false);
    expect(sorted(result.matches)).toEqual([
      { path: "src/a.ts", line: 1, lineText: "// TODO: premier", ranges: [{ start: 3, end: 7 }] },
      { path: "src/é.ts", line: 1, lineText: "const café = 'TODO après';", ranges: [{ start: 14, end: 18 }] },
    ]);
    expect(streamed.sort()).toEqual(["src/a.ts", "src/é.ts"]);
  });

  it("supports case-insensitive whole words, globs, and caps results", async () => {
    const words = await searchText(workspace.path, { ...base, pattern: "todo", wholeWord: true, include: ["src/a.ts"] }, { rgPath });
    expect(sorted(words.matches).map((match) => match.line)).toEqual([1, 2]);
    const capped = await searchText(workspace.path, { ...base, pattern: "TODO", maxResults: 1 }, { rgPath });
    expect(capped).toMatchObject({ truncated: true });
    expect(capped.matches).toHaveLength(1);
  });

  it("reports an invalid regex and a cancelled search", async () => {
    await expect(searchText(workspace.path, { ...base, pattern: "(", isRegex: true }, { rgPath })).rejects.toMatchObject({
      code: "invalid_argument",
    });
    const controller = new AbortController();
    controller.abort();
    await expect(searchText(workspace.path, { ...base, pattern: "x" }, { rgPath, signal: controller.signal })).rejects.toMatchObject({
      code: "cancelled",
    });
  });

  it("converts byte offsets after multi-byte characters and skips non-canonical paths", () => {
    const match = toSearchMatch({
      path: { text: "./a.txt" },
      lines: { text: "ééx\n" },
      line_number: 3,
      submatches: [{ start: 4, end: 5 }],
    });
    expect(match).toEqual({ path: "a.txt", line: 3, lineText: "ééx", ranges: [{ start: 2, end: 3 }] });
    expect(toSearchMatch({ path: { text: "../x" }, lines: { text: "a" }, line_number: 1 })).toBeNull();
  });

  it("reads the Windows form of ripgrep paths (`.\\src\\cart.ts`)", () => {
    const match = toSearchMatch({ path: { text: ".\\src\\cart.ts" }, lines: { text: "return items.length;\r\n" }, line_number: 2 });
    expect(match).toEqual({ path: "src/cart.ts", line: 2, lineText: "return items.length;", ranges: [] });
    expect(toSearchMatch({ path: { text: ".\\..\\x" }, lines: { text: "a" }, line_number: 1 })).toBeNull();
  });
});
