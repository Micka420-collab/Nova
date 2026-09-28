import { describe, expect, it } from "vitest";
import { diffHunks, revertHunks, splitLines, unifiedPatch } from "./line-diff";

const lines = (count: number, label = "l"): string => Array.from({ length: count }, (_, index) => `${label}${index + 1}\n`).join("");

describe("mission line diff", () => {
  // 30 lines; the mission changed line 3 and line 25 (far apart: two hunks) and appended a line.
  const before = lines(30);
  const after = before.replace("l3\n", "L3 changed\n").replace("l25\n", "l25\nadded after 25\n") + "tail\n";

  it("groups changes in unified-diff hunks with three lines of context", () => {
    expect(diffHunks(before, after)).toEqual([
      { oldStart: 0, oldLines: 6, newStart: 0, newLines: 6 },
      { oldStart: 22, oldLines: 8, newStart: 22, newLines: 10 },
    ]);
    expect(diffHunks(before, before)).toEqual([]);
  });

  it("reverts only the chosen hunks, and all of them gives the original back", () => {
    expect(revertHunks(before, after, [0])).toBe(before.replace("l25\n", "l25\nadded after 25\n") + "tail\n");
    expect(revertHunks(before, after, [1])).toBe(before.replace("l3\n", "L3 changed\n"));
    expect(revertHunks(before, after, [1, 0])).toBe(before);
    expect(revertHunks(before, after, [])).toBe(after);
    expect(revertHunks(before, after, [2])).toBeNull();
  });

  it("keeps line endings exactly (CRLF, missing final newline) and handles created files", () => {
    const crlf = "a\r\nb\r\nc";
    const edited = "a\r\nB\r\nc\r\nd";
    expect(splitLines(edited)).toEqual(["a\r\n", "B\r\n", "c\r\n", "d"]);
    expect(revertHunks(crlf, edited, [0])).toBe(crlf);
    // A file the mission created: its base is empty, reverting the only hunk empties it.
    expect(diffHunks("", "x\ny\n")).toEqual([{ oldStart: 0, oldLines: 0, newStart: 0, newLines: 2 }]);
    expect(revertHunks("", "x\ny\n", [0])).toBe("");
  });

  it("matches a brute-force check on scrambled edits", () => {
    let seed = 7;
    const random = (max: number): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
      return seed % max;
    };
    for (let round = 0; round < 50; round += 1) {
      const base = Array.from({ length: 5 + random(40) }, () => `v${random(6)}\n`);
      const edited = [...base];
      for (let edit = 0; edit < 1 + random(6); edit += 1) {
        const at = random(edited.length + 1);
        const kind = random(3);
        if (kind === 0) edited.splice(at, 0, `new${random(9)}\n`);
        else if (kind === 1 && edited.length > 0) edited.splice(Math.min(at, edited.length - 1), 1);
        else if (edited.length > 0) edited[Math.min(at, edited.length - 1)] = `chg${random(9)}\n`;
      }
      const a = base.join("");
      const b = edited.join("");
      const hunks = diffHunks(a, b) ?? [];
      const all = hunks.map((_, index) => index);
      expect(revertHunks(a, b, all)).toBe(a);
      expect(revertHunks(a, b, [])).toBe(b);
    }
  });
});

describe("unifiedPatch", () => {
  it("writes git-style hunks in diffHunks order, keeping CRLF and a missing final newline", () => {
    const before = "a\r\nb\r\nc\r\nd\r\ne\r\nf\r\ng\r\nh\r\ni\r\nj\r\nk\r\nl";
    const after = "a\r\nB\r\nc\r\nd\r\ne\r\nf\r\ng\r\nh\r\ni\r\nj\r\nk\r\nL";
    expect(diffHunks(before, after)).toHaveLength(2);
    expect(unifiedPatch("src/x.txt", before, after)).toBe(
      [
        "--- a/src/x.txt",
        "+++ b/src/x.txt",
        "@@ -1,5 +1,5 @@",
        " a\r",
        "-b\r",
        "+B\r",
        " c\r",
        " d\r",
        " e\r",
        "@@ -9,4 +9,4 @@",
        " i\r",
        " j\r",
        " k\r",
        "-l",
        "\\ No newline at end of file",
        "+L",
        "\\ No newline at end of file",
        "",
      ].join("\n"),
    );
  });

  it("describes created and deleted files against /dev/null, and equal texts as empty", () => {
    expect(unifiedPatch("n.ts", null, "x\ny\n")).toBe("--- /dev/null\n+++ b/n.ts\n@@ -0,0 +1,2 @@\n+x\n+y\n");
    expect(unifiedPatch("n.ts", "x\n", null)).toBe("--- a/n.ts\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-x\n");
    expect(unifiedPatch("n.ts", "same\n", "same\n")).toBe("");
  });
});
