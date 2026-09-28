import { symlink } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileIndex, fuzzyScore, rankPaths } from "./file-index";
import { createIgnoreMatcher } from "./ignore-rules";
import { makeTempDir, type TempDir } from "./test-support";

let workspace: TempDir;
let outside: TempDir;
beforeEach(async () => {
  workspace = await makeTempDir();
  outside = await makeTempDir("nova-outside-");
});
afterEach(async () => {
  await workspace.cleanup();
  await outside.cleanup();
});

describe("fuzzy ranking", () => {
  it("prefers file-name and word-start matches, and rejects non-subsequences", () => {
    const paths = [
      "src/components/ButtonGroup.tsx",
      "src/utils/bogus-tricks.ts",
      "docs/button.md",
      "src/components/Button.tsx",
    ];
    expect(rankPaths(paths, "button", 10).paths.slice(0, 2).sort()).toEqual(["docs/button.md", "src/components/Button.tsx"]);
    expect(rankPaths(paths, "btg", 10).paths[0]).toBe("src/components/ButtonGroup.tsx");
    expect(fuzzyScore("src/a.ts", "zz")).toBeNull();
    expect(rankPaths(paths, "s", 2)).toMatchObject({ truncated: true });
  });
});

describe("file index", () => {
  it("indexes non-ignored files, never follows links outside, and applies watcher changes", async () => {
    await workspace.write(".gitignore", "dist/\n");
    await workspace.write("src/main.ts", "");
    await workspace.write("dist/main.js", "");
    await workspace.write("node_modules/x/index.js", "");
    await outside.write("secret.ts", "");
    await symlink(outside.path, join(workspace.path, "linked"));
    const index = new FileIndex(workspace.path, createIgnoreMatcher(workspace.path));
    expect(await index.all()).toEqual([".gitignore", "src/main.ts"]);

    index.apply([
      { kind: "created", path: "src/new.ts", isDirectory: false },
      { kind: "deleted", path: "src", isDirectory: true },
      { kind: "created", path: "lib/util.ts", isDirectory: false },
    ]);
    expect(await index.all()).toEqual([".gitignore", "lib/util.ts"]);
    expect((await index.search("util", 5)).paths).toEqual(["lib/util.ts"]);
  });
});
