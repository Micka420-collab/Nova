import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isWorkspaceError } from "./errors";
import { makeTempDir, type TempDir } from "./test-support";
import { createWorktreeManager, isWorktreeId, type WorktreeManager } from "./worktree";

const ID = "0f3c2a4e-1b2c-4d5e-8f90-123456789abc";
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "t@example.test",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "t@example.test",
  GIT_CONFIG_NOSYSTEM: "1",
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" });
}

let project: TempDir;
let data: TempDir;
let manager: WorktreeManager;

beforeEach(async () => {
  project = await makeTempDir("nova-wt-project-");
  data = await makeTempDir("nova-wt-data-");
  git(project.path, "init", "-q", "-b", "main");
  await project.write("src/a.txt", "alpha\n");
  await project.write("src/b.txt", "beta\n");
  await project.write(".gitignore", "node_modules/\n");
  git(project.path, "add", "-A");
  git(project.path, "commit", "-q", "-m", "init");
  manager = createWorktreeManager({ dataDir: data.path, env: GIT_ENV });
});

afterEach(async () => {
  await project.cleanup();
  await data.cleanup();
});

describe("worktree manager", () => {
  it("checks out HEAD under <dataDir>/worktrees/<id>, never inside the project", async () => {
    const info = await manager.add(project.path, ID);
    expect(info.path).toBe(join(data.path, "worktrees", ID));
    expect(info.root).toBe(info.path);
    expect(info.baseSha).toBe(git(project.path, "rev-parse", "HEAD").trim());
    expect(readFileSync(join(info.root, "src/a.txt"), "utf8")).toBe("alpha\n");
    // The project's working tree is unchanged (only git's own bookkeeping is added).
    expect(git(project.path, "status", "--porcelain")).toBe("");
  });

  it("runs no repository hook nor filter driver while checking out", async () => {
    const marker = join(data.path, "hook-ran");
    const hook = join(project.path, ".git", "hooks", "post-checkout");
    await writeFile(hook, `#!/bin/sh\ntouch "${marker}"\n`);
    await chmod(hook, 0o755);
    const smudgeMarker = join(data.path, "smudge-ran");
    git(project.path, "config", "filter.evil.smudge", `sh -c 'touch "${smudgeMarker}"; cat'`);
    await project.write(".gitattributes", "*.txt filter=evil\n");
    git(project.path, "add", "-A");
    git(project.path, "commit", "-q", "-m", "attrs");
    await rm(smudgeMarker, { force: true });
    await rm(marker, { force: true });

    await manager.add(project.path, ID);
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(smudgeMarker)).toBe(false);
  });

  it("reports the child's changes (committed or not, untracked) but never the linked dependencies", async () => {
    await mkdir(join(project.path, "node_modules", "pkg"), { recursive: true });
    await writeFile(join(project.path, "node_modules", "pkg", "index.js"), "module.exports = 1;\n");
    const info = await manager.add(project.path, ID);
    expect(readFileSync(join(info.root, "node_modules", "pkg", "index.js"), "utf8")).toContain("module.exports");

    await writeFile(join(info.root, "src/a.txt"), "alpha 2\n");
    await rm(join(info.root, "src/b.txt"));
    await writeFile(join(info.root, "src/c.txt"), "gamma\n");
    // A commit inside the worktree does not hide its changes from the base.
    git(info.root, "add", "src/a.txt");
    git(info.root, "commit", "-q", "-m", "child commit");

    const again = await manager.get(project.path, ID);
    expect(again?.baseSha).toBe(info.baseSha);
    const { changes, truncated } = await manager.changes(again ?? info);
    expect(truncated).toBe(false);
    expect(changes).toEqual([
      { path: "src/a.txt", change: "modified" },
      { path: "src/b.txt", change: "deleted" },
      { path: "src/c.txt", change: "added" },
    ]);
  });

  it("works for a project that is a sub-folder of its repository", async () => {
    const sub = join(project.path, "src");
    const info = await manager.add(sub, ID);
    expect(info.root).toBe(join(info.path, "src"));
    await writeFile(join(info.root, "a.txt"), "changed\n");
    expect((await manager.changes(info)).changes).toEqual([{ path: "a.txt", change: "modified" }]);
    expect(await manager.changedInProject(sub, info.baseSha, ["a.txt", "b.txt"])).toEqual(new Set());
  });

  it("reports changes when the data dir is reached through a symlink (macOS /var), refuses a checkout elsewhere", async () => {
    const link = join(data.path, "..", `${basename(data.path)}-link`);
    await symlink(data.path, link, process.platform === "win32" ? "junction" : "dir");
    try {
      const linked = createWorktreeManager({ dataDir: link, env: GIT_ENV });
      const info = await linked.add(project.path, ID);
      expect(info.path).toBe(join(data.path, "worktrees", ID));
      await writeFile(join(info.root, "src/a.txt"), "changed\n");
      expect((await linked.changes(info)).changes).toEqual([{ path: "src/a.txt", change: "modified" }]);
      await expect(linked.changes({ ...info, path: project.path, root: project.path })).rejects.toSatisfy((error: unknown) =>
        isWorkspaceError(error, "outside_workspace"),
      );
    } finally {
      await unlink(link);
    }
  });

  it("tells which files the user changed in the project since the base", async () => {
    const info = await manager.add(project.path, ID);
    await writeFile(join(project.path, "src/a.txt"), "user edit\n");
    const changed = await manager.changedInProject(project.path, info.baseSha, ["src/a.txt", "src/b.txt", "src/new.txt"]);
    expect([...changed]).toEqual(["src/a.txt"]);
  });

  it("removes the checkout and git's bookkeeping without touching the project's dependencies", async () => {
    await mkdir(join(project.path, "node_modules"), { recursive: true });
    await writeFile(join(project.path, "node_modules", "keep.js"), "1");
    const info = await manager.add(project.path, ID);
    expect(await manager.list()).toEqual([ID]);

    await manager.remove(project.path, ID);
    expect(existsSync(info.path)).toBe(false);
    expect(await readFile(join(project.path, "node_modules", "keep.js"), "utf8")).toBe("1");
    expect(git(project.path, "worktree", "list")).not.toContain(ID);
    expect(await manager.list()).toEqual([]);
    // Idempotent.
    await manager.remove(project.path, ID);
  });

  it("refuses a folder that is not a repository, a repository without commit, and invalid ids", async () => {
    const plain = await makeTempDir("nova-wt-plain-");
    try {
      await expect(manager.add(plain.path, ID)).rejects.toSatisfy((error: unknown) => isWorkspaceError(error, "unavailable"));
      git(plain.path, "init", "-q");
      await expect(manager.add(plain.path, ID)).rejects.toSatisfy((error: unknown) => isWorkspaceError(error, "unavailable"));
    } finally {
      await plain.cleanup();
    }
    for (const id of ["../escape", "a/b", "", ".hidden", "x".repeat(65)]) {
      expect(isWorktreeId(id)).toBe(false);
      await expect(manager.add(project.path, id)).rejects.toSatisfy((error: unknown) => isWorkspaceError(error, "invalid_argument"));
      await expect(manager.remove(project.path, id)).rejects.toSatisfy((error: unknown) => isWorkspaceError(error, "invalid_argument"));
    }
  });
});
