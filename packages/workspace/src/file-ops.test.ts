import { existsSync } from "node:fs";
import { mkdir, readFile, rename, symlink, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CHECKPOINT_FILE_MAX_BYTES, createCheckpointStore, type CheckpointStore } from "./checkpoints";
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

  it("applies C8 to what a symlink inside the workspace leads to (reads, writes, moves, trash)", async () => {
    await workspace.write(".env", "TOKEN=x");
    await workspace.write("docs/readme.md", "r");
    await mkdir(join(workspace.path, ".git", "hooks"), { recursive: true });
    await symlink(".env", join(workspace.path, "notes.txt"));
    await symlink(".git", join(workspace.path, "gitlink"));
    await expect(ops.readFile("notes.txt")).rejects.toMatchObject({ code: "excluded_path" });
    await expect(ops.list("gitlink")).rejects.toMatchObject({ code: "excluded_path" });
    await expect(
      ops.writeFile("gitlink/hooks/pre-commit", "#!/bin/sh\n", { expectedHash: null, checkpointId }),
    ).rejects.toMatchObject({ code: "excluded_path" });
    await expect(ops.writeFile("gitlink/new/dir/x", "x", { expectedHash: null, checkpointId })).rejects.toMatchObject({
      code: "excluded_path",
    });
    await expect(ops.move("docs/readme.md", "gitlink/hooks/post-checkout", { checkpointId })).rejects.toMatchObject({
      code: "excluded_path",
    });
    expect(existsSync(join(workspace.path, ".git", "hooks", "pre-commit"))).toBe(false);
    expect(existsSync(join(workspace.path, ".git", "new"))).toBe(false);
    expect(await read("docs/readme.md")).toBe("r");
  });

  it("follows .novaignore changes without a restart, and never lets the agent rewrite it", async () => {
    await workspace.write("private/notes.txt", "secret plans");
    expect((await ops.readFile("private/notes.txt")).content).toBe("secret plans");
    await writeFile(join(workspace.path, ".novaignore"), "private/\n");
    await expect(ops.readFile("private/notes.txt")).rejects.toMatchObject({ code: "excluded_path" });
    expect((await ops.readFile(".novaignore")).content).toBe("private/");
    await expect(ops.writeFile(".novaignore", "", { expectedHash: sha256("private/\n"), checkpointId })).rejects.toMatchObject({
      code: "excluded_path",
    });
    await expect(ops.trash(".novaignore", { checkpointId })).rejects.toMatchObject({ code: "excluded_path" });
    expect(await read(".novaignore")).toBe("private/\n");
  });

  it("checkpoints every file of a moved or trashed folder, restorably, and refuses folders holding excluded files", async () => {
    await workspace.write("src/legacy/a.ts", "a");
    await workspace.write("src/legacy/deep/b.ts", "b");
    await workspace.write("tools/c.ts", "c");
    await ops.trash("src/legacy", { checkpointId });
    await ops.move("tools", "lib", { checkpointId });
    const files = checkpoints.get(checkpointId)?.files ?? [];
    expect(files.map((file) => [file.path, file.beforeHash, file.afterHash])).toEqual([
      ["lib/c.ts", null, sha256("c")],
      ["src/legacy/a.ts", sha256("a"), null],
      ["src/legacy/deep/b.ts", sha256("b"), null],
      ["tools/c.ts", sha256("c"), null],
    ]);
    const restored = await checkpoints.restoreAll({ checkpointId, root: workspace.path });
    expect(restored.results.every((result) => result.status === "restored")).toBe(true);
    expect([await read("src/legacy/a.ts"), await read("src/legacy/deep/b.ts"), await read("tools/c.ts")]).toEqual(["a", "b", "c"]);
    expect(existsSync(join(workspace.path, "lib", "c.ts"))).toBe(false);

    await workspace.write("app/.env", "TOKEN=x");
    await expect(ops.trash("app", { checkpointId })).rejects.toMatchObject({ code: "excluded_path" });
    await expect(ops.move("app", "app2", { checkpointId })).rejects.toMatchObject({ code: "excluded_path" });
    expect(trashed).toEqual([join(workspace.path, "src", "legacy")]);
    expect(await read("app/.env")).toBe("TOKEN=x");
  });

  it("refuses to move or trash a file too large for a restore point, from its size alone", async () => {
    await workspace.write("data/big.bin", "");
    await truncate(join(workspace.path, "data", "big.bin"), CHECKPOINT_FILE_MAX_BYTES + 1);
    await expect(ops.trash("data/big.bin", { checkpointId })).rejects.toMatchObject({ code: "too_large" });
    await expect(ops.move("data/big.bin", "data/moved.bin", { checkpointId })).rejects.toMatchObject({ code: "too_large" });
    expect(trashed).toEqual([]);
    expect(existsSync(join(workspace.path, "data", "big.bin"))).toBe(true);
    expect(checkpoints.get(checkpointId)?.files).toEqual([]);
  });
});
