import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createCheckpointStore, type CheckpointStore } from "./checkpoints";
import { createWorkspaceFileOps, type WorkspaceFileOps } from "./file-ops";
import { sha256 } from "./hash";
import { createIgnoreMatcher } from "./ignore-rules";
import { createObjectStore } from "./object-store";
import { createMemoryCheckpointIndex, makeTempDir, ripgrepForTests, type TempDir } from "./test-support";

let rgPath: string;
let workspace: TempDir;
let data: TempDir;
let checkpoints: CheckpointStore;
let ops: WorkspaceFileOps;
let trashed: string[];
let checkpointId: string;

beforeAll(async () => {
  rgPath = await ripgrepForTests();
});
beforeEach(async () => {
  workspace = await makeTempDir();
  data = await makeTempDir("nova-data-");
  trashed = [];
  checkpoints = createCheckpointStore({
    index: createMemoryCheckpointIndex(),
    objects: createObjectStore(join(data.path, "objects")),
  });
  checkpointId = checkpoints.create({ workspaceId: "ws", missionId: null, label: "Étape", reason: "tool_write" }).id;
  ops = createWorkspaceFileOps({
    workspaceId: "ws",
    root: workspace.path,
    matcher: createIgnoreMatcher(workspace.path),
    checkpoints,
    rgPath,
    trash: async (absolute) => {
      trashed.push(absolute);
      await rename(absolute, join(data.path, "trashed"));
    },
  });
});
afterEach(async () => {
  await workspace.cleanup();
  await data.cleanup();
});

const read = (path: string): Promise<string> => readFile(join(workspace.path, path), "utf8");

describe("agent file operations", () => {
  it("reads line ranges and refuses excluded or binary files", async () => {
    await workspace.write("a.ts", "l1\nl2\nl3\n");
    await workspace.write(".env", "TOKEN=x");
    await workspace.write("img.png", new Uint8Array([0, 1, 2]));
    expect(await ops.readFile("a.ts", { startLine: 2, endLine: 9 })).toEqual({
      path: "a.ts",
      hash: sha256("l1\nl2\nl3\n"),
      startLine: 2,
      endLine: 3,
      totalLines: 3,
      content: "l2\nl3",
      truncated: false,
    });
    await expect(ops.readFile(".env")).rejects.toMatchObject({ code: "excluded_path" });
    await expect(ops.readFile("img.png")).rejects.toMatchObject({ code: "binary" });
    await expect(ops.writeFile(".env", "x", { expectedHash: sha256("TOKEN=x"), checkpointId })).rejects.toMatchObject({
      code: "excluded_path",
    });
  });

  it("edits with exact unique replacement, checkpoints the change, and refuses ambiguity", async () => {
    await workspace.write("cart.ts", "const total = a + b;\nconst tax = 0;\nconst tax2 = 0;\n");
    const outcome = await ops.editFile("cart.ts", [{ oldText: "a + b", newText: "a + b + c" }], { checkpointId });
    expect(outcome).toMatchObject({ status: "written", additions: 1, deletions: 1, created: false, checkpointId });
    expect(outcome.status === "written" ? outcome.excerpt?.text : null).toContain("a + b + c");
    expect(checkpoints.get(checkpointId)?.files).toEqual([
      {
        checkpointId,
        path: "cart.ts",
        beforeHash: sha256("const total = a + b;\nconst tax = 0;\nconst tax2 = 0;\n"),
        afterHash: sha256("const total = a + b + c;\nconst tax = 0;\nconst tax2 = 0;\n"),
        userHashSeen: null,
      },
    ]);

    await expect(ops.editFile("cart.ts", [{ oldText: "= 0;", newText: "= 1;" }], { checkpointId })).rejects.toMatchObject({
      code: "invalid_argument",
    });
    await expect(ops.editFile("cart.ts", [{ oldText: "missing", newText: "" }], { checkpointId })).rejects.toMatchObject({
      code: "not_found",
    });
    // Several edits are atomic: the second fails, so the first is not applied either.
    const before = await read("cart.ts");
    await expect(
      ops.editFile("cart.ts", [{ oldText: "tax2", newText: "vat" }, { oldText: "nope", newText: "x" }], { checkpointId }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(await read("cart.ts")).toBe(before);
  });

  it("matches LF edits in CRLF files", async () => {
    await workspace.write("win.txt", "a\r\nb\r\nc\r\n");
    await ops.editFile("win.txt", [{ oldText: "a\nb", newText: "A\nB" }], { checkpointId });
    expect(await read("win.txt")).toBe("A\r\nB\r\nc\r\n");
  });

  it("refuses to write over a version the agent did not see", async () => {
    await workspace.write("a.ts", "v1");
    const seen = sha256("v1");
    await writeFile(join(workspace.path, "a.ts"), "user edit");
    expect(await ops.writeFile("a.ts", "agent", { expectedHash: seen, checkpointId })).toEqual({
      status: "conflict",
      path: "a.ts",
      currentHash: sha256("user edit"),
    });
    expect(await read("a.ts")).toBe("user edit");
    expect(checkpoints.get(checkpointId)?.files).toEqual([]);
    expect(await ops.writeFile("b.ts", "x", { expectedHash: seen, checkpointId })).toMatchObject({ status: "conflict", currentHash: null });
    // Creating a file creates its missing folders (confined).
    expect(await ops.writeFile("new/deep/c.ts", "c", { expectedHash: null, checkpointId })).toMatchObject({ status: "written" });
    expect(await read("new/deep/c.ts")).toBe("c");
  });

  it("creates, globs, searches, moves and trashes with checkpoints", async () => {
    await workspace.write("src/one.ts", "export const one = 1;\n");
    expect(await ops.writeFile("src/two.ts", "export const two = 2;\n", { expectedHash: null, checkpointId })).toMatchObject({
      status: "written",
      created: true,
      additions: 1,
    });
    expect((await ops.glob("src/*.ts", 10)).paths).toEqual(["src/one.ts", "src/two.ts"]);
    const search = await ops.searchText({ pattern: "export", isRegex: false, caseSensitive: true, wholeWord: false, include: [], exclude: [], maxResults: 10 });
    expect(search.matches.map((match) => match.path).sort()).toEqual(["src/one.ts", "src/two.ts"]);

    await ops.move("src/one.ts", "src/uno.ts", { checkpointId });
    await ops.trash("src/two.ts", { checkpointId });
    expect(trashed).toEqual([join(workspace.path, "src", "two.ts")]);
    const files = checkpoints.get(checkpointId)?.files ?? [];
    expect(files.map((file) => [file.path, file.beforeHash !== null, file.afterHash !== null])).toEqual([
      ["src/one.ts", true, false],
      ["src/two.ts", false, false], // created then trashed in the same step: first before (none) kept
      ["src/uno.ts", false, true],
    ]);
    const restored = await checkpoints.restoreAll({ checkpointId, root: workspace.path });
    expect(restored.results.every((result) => result.status === "restored")).toBe(true);
    expect(await read("src/one.ts")).toBe("export const one = 1;\n");
  });
});
