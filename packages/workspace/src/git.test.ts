import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGitClient, findGitExecutable, omitExcludedFiles, parsePorcelainV2 } from "./git";
import { createIgnoreMatcher } from "./ignore-rules";
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
    const diff = await client.diff(repo.path, { path: "tracked.txt", staged: false, isExcluded: () => false });
    expect(diff.truncated).toBe(false);
    expect(diff.patch).toContain("-one\n+two\n");
    expect((await client.diff(repo.path, { path: null, staged: true, isExcluded: () => false })).patch).toBe("");
  });

  it("never shows the content of C8-excluded files in a diff (defaults, .novaignore, spaces, noprefix config)", async () => {
    await repo.write(".env", "TOKEN=old\n");
    await repo.write("config/app.key", "k1\n");
    await repo.write("private/my notes.txt", "a\n");
    await repo.write(".novaignore", "private/\n");
    git("add", ".");
    git("commit", "-q", "-m", "tracked secrets");
    git("config", "diff.noprefix", "true");
    await repo.write(".env", "TOKEN=hunter2-new-value\n");
    await repo.write("config/app.key", "k2-secret\n");
    await repo.write("private/my notes.txt", "b-private\n");
    await repo.write("tracked.txt", "two\n");
    const matcher = createIgnoreMatcher(repo.path);
    await matcher.load("");
    const isExcluded = (path: string): boolean => matcher.isExcluded(path);

    const diff = await client.diff(repo.path, { path: null, staged: false, isExcluded });
    expect(diff.patch).toContain("+two");
    expect(diff.patch).not.toMatch(/hunter2|k2-secret|b-private/);
    expect(diff.excluded.sort()).toEqual([".env", "config/app.key", "private/my notes.txt"]);
    const folder = await client.diff(repo.path, { path: "config", staged: false, isExcluded });
    expect(folder).toMatchObject({ patch: "", excluded: ["config/app.key"] });
    await expect(client.diff(repo.path, { path: ".env", staged: false, isExcluded })).rejects.toMatchObject({ code: "excluded_path" });
  });

  it("commits selected paths, reports nothing-to-commit, and gives the branch", async () => {
    await repo.write("tracked.txt", "two\n");
    await repo.write("other.txt", "not committed");
    const commit = await client.commit(repo.path, { message: "  Met à jour le fichier  ", paths: ["tracked.txt"], isExcluded: () => false });
    expect(commit.message).toBe("Met à jour le fichier");
    expect(commit.files).toEqual(["tracked.txt"]);
    expect(git("rev-parse", "HEAD").trim()).toBe(commit.sha);
    expect(git("show", "--name-only", "--format=", "HEAD").trim()).toBe("tracked.txt");
    await expect(client.commit(repo.path, { message: "vide", paths: [], isExcluded: () => false })).rejects.toMatchObject({ code: "conflict" });
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

  it("never runs repository-configured filter drivers on status or diff", async () => {
    const marker = join(repo.path, "pwned");
    git("config", "filter.x.clean", `touch '${marker}'; cat`);
    git("config", "filter.x.process", `touch '${marker}'`);
    git("config", "filter.x.required", "true");
    writeFileSync(join(repo.path, ".git", "info", "attributes"), "* filter=x\n");
    await repo.write("tracked.txt", "two\n");
    const status = await client.status(repo.path);
    expect(status.available && status.entries.some((entry) => entry.path === "tracked.txt")).toBe(true);
    expect((await client.diff(repo.path, { path: "tracked.txt", staged: false, isExcluded: () => false })).patch).toContain("+two");
    expect(existsSync(marker)).toBe(false);
  });

  it("gives git and its hooks the scrubbed environment", async () => {
    const dump = join(repo.path, "hook-env.txt");
    const hook = join(repo.path, ".git", "hooks", "pre-commit");
    writeFileSync(hook, `#!/bin/sh\nenv > '${dump}'\n`);
    chmodSync(hook, 0o755);
    const secretive = createGitClient({ env: { ...env, GITHUB_TOKEN: "ghp_leak", NODE_OPTIONS: "--require /x.js" } });
    await repo.write("tracked.txt", "two\n");
    await secretive.commit(repo.path, { message: "m", paths: ["tracked.txt"], isExcluded: () => false });
    const seen = readFileSync(dump, "utf8");
    expect(seen).toContain("PATH=");
    expect(seen).not.toContain("ghp_leak");
    expect(seen).not.toContain("NODE_OPTIONS");
  });

  it("never runs a git executable found through the workspace (relative PATH entry or inside the root)", async () => {
    const marker = join(repo.path, "pwned");
    const fake = join(repo.path, "git");
    writeFileSync(fake, `#!/bin/sh\ncase "$*" in *--version*) echo "git version 9";; *) touch '${marker}';; esac\n`);
    chmodSync(fake, 0o755);
    const realGit = await findGitExecutable(process.env);
    expect(realGit).not.toBeNull();
    const viaCwd = createGitClient({ env: { ...env, PATH: `.${delimiter}${dirname(realGit as string)}` } });
    expect(await viaCwd.status(repo.path)).toMatchObject({ available: true, branch: "main" });
    const inside = createGitClient({ env, gitPath: fake });
    expect(await inside.status(repo.path)).toEqual({ available: false });
    await expect(inside.commit(repo.path, { message: "m", paths: "all", isExcluded: () => false })).rejects.toMatchObject({ code: "unavailable" });
    expect(existsSync(marker)).toBe(false);
  });

  it("refuses a commit that would include C8-excluded files (defaults or .novaignore) before staging", async () => {
    await repo.write(".novaignore", "secrets/\n");
    git("add", ".novaignore");
    git("commit", "-q", "-m", "rules");
    await repo.write(".env", "TOKEN=x");
    await repo.write("secrets/prod.json", "{}");
    await repo.write("tracked.txt", "two\n");
    const matcher = createIgnoreMatcher(repo.path);
    await matcher.load("");
    const isExcluded = (path: string): boolean => matcher.isExcluded(path);
    await expect(client.commit(repo.path, { message: "all", paths: "all", isExcluded })).rejects.toMatchObject({ code: "excluded_path" });
    await expect(client.commit(repo.path, { message: "one", paths: ["secrets/prod.json"], isExcluded })).rejects.toMatchObject({
      code: "excluded_path",
    });
    expect(git("diff", "--cached", "--name-only").trim()).toBe("");
    const ok = await client.commit(repo.path, { message: "tracked only", paths: ["tracked.txt"], isExcluded });
    expect(ok.files).toEqual(["tracked.txt"]);
    expect(git("show", "--name-only", "--format=", ok.sha).trim()).toBe("tracked.txt");
  });

  it("reports git missing as unavailable", async () => {
    const missing = createGitClient({ gitPath: "/nonexistent/git", env });
    expect(await missing.available()).toBe(false);
    expect(await missing.status(repo.path)).toEqual({ available: false });
  });
});

describe("omitExcludedFiles", () => {
  it("reads quoted and combined headers and drops a section whose header it cannot read", () => {
    const section = (header: string, body: string): string => `${header}\n--- x\n+++ y\n@@ -1 +1 @@\n-old\n+${body}\n`;
    const patch = [
      section('diff --git "a/sec\\303\\251/t\\tab" "b/sec\\303\\251/t\\tab"', "quoted-secret"),
      section("diff --cc .env", "conflict-secret"),
      section("diff --git a/ok b.ts b/ok b.ts", "visible"),
      "diff --git a/.en",
    ].join("");
    const result = omitExcludedFiles(patch, (path) => path.startsWith("secé/") || path === ".env");
    expect(result.patch).toContain("+visible");
    expect(result.patch).not.toMatch(/quoted-secret|conflict-secret|a\/\.en/);
    expect(result.excluded).toEqual(["secé/t\tab", ".env"]);
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
