// Git worktrees of writing sub-missions (J2-B L5): a child mission that writes works in its own
// checkout under `<dataDir>/worktrees/<id>`, never inside the project; its changes reach the project
// only through the checkpointed integration of @nova/missions (submissions).
//
// Confinement and hardening (same threat model as ./git.ts: the repository may be hostile):
// - every worktree folder is `<dataDir>/worktrees/<id>` with a validated id; removal refuses any
//   other path, and never follows the dependency links it created;
// - git runs from an absolute executable found on the absolute PATH entries (never inside the
//   project), without a shell, with the scrubbed child environment;
// - the checkout runs no repository code: hooks point to an empty NOVA folder (`post-checkout`),
//   every configured filter driver is neutralized (`smudge`/`clean`/`process`), fsmonitor is off;
// - what git writes in the project is limited to its own worktree bookkeeping
//   (`.git/worktrees/<id>`), removed with the worktree (`worktree remove` + `worktree prune`).
// Dependency folders the checkout lacks (`node_modules`…) are linked from the project so the child's
// tests can run; the agent's file API never writes through them (links leaving the root are not
// followed), and they are never reported as changes.
import { execFile } from "node:child_process";
import { lstat, mkdir, readdir, realpath, rm, stat, symlink, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isCanonicalRelativePath, scrubChildEnv, type RelativePath } from "@nova/shared";
import { isInsideRoot } from "./confine";
import { WorkspaceError, errnoCode } from "./errors";
import { findGitExecutable } from "./git";

/** Folder of the worktrees inside the data dir. */
export const WORKTREES_DIR = "worktrees";
/** Empty folder used as `core.hooksPath` while NOVA runs git on a worktree. */
const NO_HOOKS_DIR = ".no-hooks";
/** Changed files a worktree may report; above, integration is refused (too large to review). */
export const WORKTREE_CHANGES_MAX = 2_000;
/** Dependency folders linked from the project when it has them (not tracked, needed by tests). */
export const DEFAULT_DEPENDENCY_DIRS: readonly string[] = ["node_modules", ".venv"];

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
const SAFE_CONFIG = ["-c", "core.fsmonitor=false", "-c", "core.quotepath=off", "-c", "color.ui=false"];
const GIT_ENV_NAMES = ["XDG_CONFIG_HOME", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_NOSYSTEM"];
/** Pathspecs per git invocation (command-line length). */
const PATHSPEC_CHUNK = 200;

export type WorktreeChangeKind = "added" | "modified" | "deleted";

export interface WorktreeChange {
  /** Relative to the workspace (the project folder inside the repository). */
  path: RelativePath;
  change: WorktreeChangeKind;
}

export interface WorktreeInfo {
  id: string;
  /** Absolute folder of the checkout (`<dataDir>/worktrees/<id>`). */
  path: string;
  /** Absolute workspace root inside the checkout (the project may be a sub-folder of its repository). */
  root: string;
  /** Commit the checkout started from. */
  baseSha: string;
}

export interface WorktreeManagerOptions {
  /** NOVA's data dir (absolute). */
  dataDir: string;
  /** Absolute git executable (default: found on the absolute PATH entries). */
  gitPath?: string;
  env?: Readonly<Record<string, string | undefined>>;
  timeoutMs?: number;
  dependencyDirs?: readonly string[];
}

export interface WorktreeManager {
  /** Absolute `<dataDir>/worktrees`. */
  readonly dir: string;
  /** Checkout of the project's HEAD for `id`; `unavailable` outside a repository or without a commit. */
  add(projectRoot: string, id: string): Promise<WorktreeInfo>;
  /** The worktree of `id` as it is now (null when absent); `baseSha` from its HEAD history. */
  get(projectRoot: string, id: string): Promise<WorktreeInfo | null>;
  /** Files the child changed since `baseSha` (committed or not, untracked included, ignored excluded). */
  changes(info: WorktreeInfo): Promise<{ changes: WorktreeChange[]; truncated: boolean }>;
  /** Among `paths`, those whose project content differs from `baseSha` (the user changed them since). */
  changedInProject(projectRoot: string, baseSha: string, paths: readonly RelativePath[]): Promise<Set<RelativePath>>;
  /** Removes the checkout and git's bookkeeping; idempotent. `projectRoot` null = folder only. */
  remove(projectRoot: string | null, id: string): Promise<void>;
  /** Ids of the worktree folders present (residue cleanup at startup). */
  list(): Promise<string[]>;
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function isWorktreeId(id: string): boolean {
  return ID_PATTERN.test(id);
}

function literal(path: RelativePath): string {
  return `:(literal)${path}`;
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size));
  return out;
}

export function createWorktreeManager(options: WorktreeManagerOptions): WorktreeManager {
  const dir = resolve(options.dataDir, WORKTREES_DIR);
  const timeout = options.timeoutMs ?? 120_000;
  const source = options.env ?? process.env;
  const dependencyDirs = options.dependencyDirs ?? DEFAULT_DEPENDENCY_DIRS;
  const env: Record<string, string> = {
    ...scrubChildEnv(source, GIT_ENV_NAMES),
    GIT_TERMINAL_PROMPT: "0",
    GIT_PAGER: "cat",
    LC_ALL: "C",
  };
  let executable: Promise<string | null> | null = null;

  const pathOf = (id: string): string => {
    if (!isWorktreeId(id)) throw new WorkspaceError("invalid_argument", "invalid worktree id");
    return join(dir, id);
  };

  const gitFor = async (cwd: string): Promise<string> => {
    executable ??= options.gitPath ? Promise.resolve(options.gitPath) : findGitExecutable(source);
    const path = await executable;
    if (path === null) throw new WorkspaceError("unavailable", "git is not installed (not found on PATH)");
    if (isInsideRoot(cwd, path)) throw new WorkspaceError("unavailable", "refusing to run a git executable located inside the workspace");
    return path;
  };

  const run = async (cwd: string, args: readonly string[], extraEnv: Record<string, string> = {}): Promise<RunResult> => {
    const path = await gitFor(cwd);
    const hooks = join(dir, NO_HOOKS_DIR);
    return new Promise((resolvePromise, reject) => {
      execFile(
        path,
        [...SAFE_CONFIG, "-c", `core.hooksPath=${hooks}`, ...args],
        { cwd, env: { ...env, ...extraEnv }, timeout, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
        (error, stdout, stderr) => {
          if (error && typeof error.code !== "number") {
            reject(new WorkspaceError("unavailable", "git could not run"));
            return;
          }
          resolvePromise({ code: typeof error?.code === "number" ? error.code : 0, stdout, stderr });
        },
      );
    });
  };

  /** GIT_CONFIG_COUNT overrides disabling every filter driver the repository configures (see git.ts). */
  const noFiltersEnv = async (cwd: string): Promise<Record<string, string>> => {
    const listed = await run(cwd, ["config", "--null", "--name-only", "--get-regexp", "^filter\\."]);
    const drivers = new Set<string>();
    for (const key of listed.code === 0 ? listed.stdout.split("\0") : []) {
      const last = key.lastIndexOf(".");
      if (key.startsWith("filter.") && last > "filter.".length) drivers.add(key.slice("filter.".length, last));
    }
    const overrides: Record<string, string> = {};
    let count = 0;
    for (const driver of drivers) {
      for (const [name, value] of [["clean", ""], ["smudge", ""], ["process", ""], ["required", "false"]] as const) {
        overrides[`GIT_CONFIG_KEY_${count}`] = `filter.${driver}.${name}`;
        overrides[`GIT_CONFIG_VALUE_${count}`] = value;
        count += 1;
      }
    }
    return count === 0 ? {} : { ...overrides, GIT_CONFIG_COUNT: String(count) };
  };

  /** Workspace prefix inside its repository ("" at the top, "sub/dir/" otherwise); null outside a repo. */
  const prefixOf = async (root: string): Promise<string | null> => {
    const result = await run(root, ["rev-parse", "--is-inside-work-tree", "--show-prefix"]).catch(() => null);
    if (!result || result.code !== 0) return null;
    const [inside, prefix = ""] = result.stdout.split("\n");
    return inside === "true" ? prefix : null;
  };

  const workspaceRootIn = (path: string, prefix: string): string => {
    const parts = prefix.split("/").filter(Boolean);
    return parts.length === 0 ? path : join(path, ...parts);
  };

  const linkDependencies = async (projectRoot: string, workspaceRoot: string): Promise<void> => {
    for (const name of dependencyDirs) {
      const origin = join(projectRoot, name);
      const target = join(workspaceRoot, name);
      try {
        if (!(await stat(origin)).isDirectory()) continue;
        await lstat(target);
        continue; // the checkout already has it (tracked): never replaced
      } catch (error) {
        if (errnoCode(error) !== "ENOENT") continue;
      }
      try {
        const real = await realpath(origin);
        await symlink(real, target, process.platform === "win32" ? "junction" : "dir");
      } catch {
        // Best effort: without the link the child's tests may fail, which the integration reports.
      }
    }
  };

  const unlinkDependencies = async (workspaceRoot: string): Promise<void> => {
    for (const name of dependencyDirs) {
      const target = join(workspaceRoot, name);
      try {
        if ((await lstat(target)).isSymbolicLink()) await unlink(target);
      } catch {
        // absent
      }
    }
  };

  const isDependencyLink = (path: RelativePath): boolean => dependencyDirs.includes(path);

  const manager: WorktreeManager = {
    dir,

    async add(projectRoot, id) {
      const path = pathOf(id);
      await mkdir(join(dir, NO_HOOKS_DIR), { recursive: true });
      const prefix = await prefixOf(projectRoot);
      if (prefix === null) throw new WorkspaceError("unavailable", "the project is not a git repository");
      const head = await run(projectRoot, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
      const baseSha = head.stdout.trim();
      if (head.code !== 0 || !/^[0-9a-f]{40,64}$/.test(baseSha)) {
        throw new WorkspaceError("unavailable", "the repository has no commit yet");
      }
      try {
        await lstat(path);
        throw new WorkspaceError("already_exists", "a worktree with this id already exists");
      } catch (error) {
        if (error instanceof WorkspaceError) throw error;
      }
      const added = await run(projectRoot, ["worktree", "add", "--detach", "--force", path, baseSha], await noFiltersEnv(projectRoot));
      if (added.code !== 0) {
        await manager.remove(projectRoot, id).catch(() => undefined);
        throw new WorkspaceError("failed", "git worktree add failed");
      }
      const canonical = await realpath(path);
      const root = workspaceRootIn(canonical, prefix);
      await linkDependencies(projectRoot, root);
      return { id, path: canonical, root, baseSha };
    },

    async get(projectRoot, id) {
      const path = pathOf(id);
      let canonical: string;
      try {
        canonical = await realpath(path);
      } catch {
        return null;
      }
      const prefix = await prefixOf(projectRoot);
      if (prefix === null) return null;
      // The oldest entry of the worktree's HEAD log is the commit `add` checked out, even when the
      // child committed since; without a log (logAllRefUpdates off), HEAD itself.
      const log = await run(canonical, ["log", "-g", "--format=%H", "HEAD", "--"]);
      const entries = log.code === 0 ? log.stdout.split("\n").filter((line) => /^[0-9a-f]{40,64}$/.test(line)) : [];
      let baseSha = entries.at(-1) ?? null;
      if (baseSha === null) {
        const head = await run(canonical, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
        baseSha = head.code === 0 ? head.stdout.trim() : null;
      }
      if (!baseSha) return null;
      return { id, path: canonical, root: workspaceRootIn(canonical, prefix), baseSha };
    },

    async changes(info) {
      // `info.path` is canonical (realpath): so must the data dir be, which may sit behind a symlink
      // (macOS /var → /private/var, a linked home). Compared raw, every worktree is refused.
      if (!isInsideRoot(await realpath(dir), info.path)) throw new WorkspaceError("outside_workspace", "worktree outside the data dir");
      const filters = await noFiltersEnv(info.root);
      const diff = await run(
        info.root,
        ["diff", "--no-renames", "--no-ext-diff", "--no-textconv", "--relative", "--name-status", "-z", info.baseSha, "--", "."],
        filters,
      );
      if (diff.code !== 0) throw new WorkspaceError("failed", "git diff failed in the worktree");
      const byPath = new Map<RelativePath, WorktreeChangeKind>();
      const records = diff.stdout.split("\0");
      for (let index = 0; index + 1 < records.length; index += 2) {
        const status = records[index] ?? "";
        const path = records[index + 1] ?? "";
        if (!isCanonicalRelativePath(path) || path === "") continue;
        byPath.set(path, status.startsWith("A") ? "added" : status.startsWith("D") ? "deleted" : "modified");
      }
      const untracked = await run(info.root, ["ls-files", "--others", "--exclude-standard", "-z", "--", "."], filters);
      if (untracked.code !== 0) throw new WorkspaceError("failed", "git ls-files failed in the worktree");
      for (const path of untracked.stdout.split("\0")) {
        if (path === "" || !isCanonicalRelativePath(path) || isDependencyLink(path)) continue;
        byPath.set(path, "added");
      }
      const sorted = [...byPath.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      const truncated = sorted.length > WORKTREE_CHANGES_MAX;
      return { changes: sorted.slice(0, WORKTREE_CHANGES_MAX).map(([path, change]) => ({ path, change })), truncated };
    },

    async changedInProject(projectRoot, baseSha, paths) {
      const changed = new Set<RelativePath>();
      if (paths.length === 0) return changed;
      const filters = await noFiltersEnv(projectRoot);
      for (const group of chunks(paths, PATHSPEC_CHUNK)) {
        const result = await run(
          projectRoot,
          ["diff", "--no-renames", "--no-ext-diff", "--no-textconv", "--relative", "--name-only", "-z", baseSha, "--", ...group.map(literal)],
          filters,
        );
        if (result.code !== 0) throw new WorkspaceError("failed", "git diff failed in the project");
        for (const path of result.stdout.split("\0")) if (path !== "") changed.add(path);
      }
      return changed;
    },

    async remove(projectRoot, id) {
      const path = pathOf(id);
      let exists = true;
      try {
        await lstat(path);
      } catch {
        exists = false;
      }
      if (exists) {
        // Links first, explicitly: nothing below may reach the project's dependency folders.
        const prefix = projectRoot === null ? null : await prefixOf(projectRoot);
        await unlinkDependencies(workspaceRootIn(path, prefix ?? ""));
        if (projectRoot !== null) await run(projectRoot, ["worktree", "remove", "--force", "--force", path]).catch(() => null);
        await rm(path, { recursive: true, force: true });
      }
      if (projectRoot !== null) await run(projectRoot, ["worktree", "prune"]).catch(() => null);
    },

    async list() {
      try {
        const entries = await readdir(dir, { withFileTypes: true });
        return entries.filter((entry) => entry.isDirectory() && isWorktreeId(entry.name)).map((entry) => entry.name).sort();
      } catch {
        return [];
      }
    },
  };
  return manager;
}
