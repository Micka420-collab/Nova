import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGitClient, parsePorcelainV2 } from "./git";
import { makeTempDir, type TempDir } from "./test-support";

let repo: TempDir;
const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const git = (...args: string[]): string => execFileSync("git", args, { cwd: repo.path, env, encoding: "utf8" });

beforeEach(async () => {
  repo = await makeTempDir("nova-git-");
  git("init", "-q", "-b", "main");
  git("config", "user.email", "nova@example.invalid");
  git("config", "user.name", "Nova Test");
  await repo.write("tracked.txt", "one\n");
  await repo.write("app/old name.ts", "export const a = 1;\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
});
afterEach(() => repo.cleanup());

describe("git client", () => {
  const client = createGitClient({ env });

  it("parses status (modified, staged, renamed with spaces, untracked) and scopes it to a subfolder", async () => {
    await repo.write("tracked.txt", "two\n");
    git("mv", "app/old name.ts", "app/new name.ts");
    await repo.write("app/fresh.ts", "x");
    await repo.write("notes.md", "n");

    const status = await client.status(repo.path);
    expect(status).toMatchObject({ available: true, branch: "main", upstream: null, ahead: null, behind: null, truncated: false });
    if (!status.available) return;
    const byPath = Object.fromEntries(status.entries.map((entry) => [entry.path, entry]));
    expect(byPath["tracked.txt"]).toEqual({ path: "tracked.txt", origPath: null, index: "unmodified", worktree: "modified" });
    expect(byPath["app/new name.ts"]).toEqual({ path: "app/new name.ts", origPath: "app/old name.ts", index: "renamed", worktree: "unmodified" });
    expect(byPath["notes.md"]).toMatchObject({ index: "untracked", worktree: "untracked" });

    const sub = await client.status(join(repo.path, "app"));
    if (!sub.available) throw new Error("expected a repository");
    expect(sub.entries.map((entry) => entry.path).sort()).toEqual(["fresh.ts", "new name.ts"]);
  });

  it("returns unified diffs per file and staged", async () => {
    await repo.write("tracked.txt", "two\n");
    const diff = await client.diff(repo.path, { path: "tracked.txt", staged: false });
    expect(diff.truncated).toBe(false);
    expect(diff.patch).toContain("-one\n+two\n");
    expect((await client.diff(repo.path, { path: null, staged: true })).patch).toBe("");
  });

  it("commits selected paths, reports nothing-to-commit, and gives the branch", async () => {
    await repo.write("tracked.txt", "two\n");
    await repo.write("other.txt", "not committed");
    const commit = await client.commit(repo.path, { message: "  Met à jour le fichier  ", paths: ["tracked.txt"] });
    expect(commit.message).toBe("Met à jour le fichier");
    expect(git("rev-parse", "HEAD").trim()).toBe(commit.sha);
    expect(git("show", "--name-only", "--format=", "HEAD").trim()).toBe("tracked.txt");
    await expect(client.commit(repo.path, { message: "vide", paths: [] })).rejects.toMatchObject({ code: "conflict" });
    expect(await client.branch(repo.path)).toBe("main");
  });

  it("is unavailable outside a repository and never runs a repository-configured fsmonitor", async () => {
    const plain = await makeTempDir();
    expect(await client.status(plain.path)).toEqual({ available: false });
    expect(await client.isRepo(plain.path)).toBe(false);
    await plain.cleanup();

    const marker = join(repo.path, "pwned");
    git("config", "core.fsmonitor", `touch '${marker}'; false`);
    await client.status(repo.path);
    expect(existsSync(marker)).toBe(false);
  });

  it("reports git missing as unavailable", async () => {
    const missing = createGitClient({ gitPath: "/nonexistent/git", env });
    expect(await missing.available()).toBe(false);
    expect(await missing.status(repo.path)).toEqual({ available: false });
  });
});

describe("porcelain v2 parser", () => {
  it("reads branch, upstream counts, conflicts and caps entries", () => {
    const output = [
      "# branch.oid abc",
      "# branch.head feature",
      "# branch.upstream origin/feature",
      "# branch.ab +2 -1",
      "u UU N... 100644 100644 100644 100644 a b c conflict.ts",
      "! build/",
      "1 .M N... 100644 100644 100644 a b outside/x.ts",
      "",
    ].join("\0");
    expect(parsePorcelainV2(output, "")).toEqual({
      available: true,
      branch: "feature",
      upstream: "origin/feature",
      ahead: 2,
      behind: 1,
      entries: [
        { path: "conflict.ts", origPath: null, index: "conflicted", worktree: "conflicted" },
        { path: "build", origPath: null, index: "ignored", worktree: "ignored" },
        { path: "outside/x.ts", origPath: null, index: "unmodified", worktree: "modified" },
      ],
      truncated: false,
    });
    const many = Array.from({ length: 2_001 }, (_, index) => `? f${index}`).join("\0");
    expect(parsePorcelainV2(many)).toMatchObject({ truncated: true });
    expect(parsePorcelainV2("? web/a.ts\0? api/b.ts\0", "web/").entries.map((entry) => entry.path)).toEqual(["a.ts"]);
  });
});
