// Git through the system `git` CLI (A5): execFile without a shell, relative paths only.
// Hardening against repository-controlled code execution (a folder from an untrusted archive can
// ship its own `.git/config`, `.git/info/attributes` and even a `git.exe`):
// - the executable is resolved once to an absolute path from the absolute PATH entries (never the
//   cwd: Windows' search looks in the child's cwd first) and refused when it lies in the workspace;
// - read commands force `core.fsmonitor` off, never run external diff drivers or textconv, and
//   neutralize every configured `filter.<driver>` (status and diff would otherwise run its `clean`
//   or `process` command on modified files);
// - git and anything it runs (commit hooks, filters) get the scrubbed child environment, never
//   NOVA's tokens, NODE_OPTIONS or ELECTRON_*.
// NOVA never pushes, fetches or stashes.
import { execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
import {
  isCanonicalRelativePath,
  scrubChildEnv,
  type GitChangeKind,
  type GitDiff,
  type GitStatus,
  type GitStatusEntry,
  type RelativePath,
} from "@nova/shared";
import { isInsideRoot } from "./confine";
import { WorkspaceError } from "./errors";

export const GIT_STATUS_MAX_ENTRIES = 2_000;
export const GIT_DIFF_MAX_BYTES = 1024 * 1024;

const SAFE_CONFIG = ["-c", "core.fsmonitor=false", "-c", "core.quotepath=off", "-c", "color.ui=false"];

/**
 * Variables git itself needs beyond the child allowlist: config locations, identity, and the
 * agents a signed commit talks to (socket paths, not secrets).
 */
const GIT_ENV_NAMES = [
  "XDG_CONFIG_HOME", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_NOSYSTEM",
  "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL",
  "GNUPGHOME", "GPG_TTY", "SSH_AUTH_SOCK", "XDG_RUNTIME_DIR", "DISPLAY", "WAYLAND_DISPLAY", "DBUS_SESSION_BUS_ADDRESS",
];

export interface GitClientOptions {
  /** Absolute path of the git executable (default: found on the absolute PATH entries). */
  gitPath?: string;
  timeoutMs?: number;
  /** Environment to scrub (default process.env). */
  env?: Readonly<Record<string, string | undefined>>;
}

/**
 * Absolute realpath of `git` from the ABSOLUTE entries of PATH, or null. Relative entries ("", ".")
 * are skipped: they would resolve against the child's cwd, i.e. the workspace.
 */
export async function findGitExecutable(env: Readonly<Record<string, string | undefined>>): Promise<string | null> {
  const windows = process.platform === "win32";
  const pathValue = env.PATH ?? env.Path ?? "";
  for (const dir of pathValue.split(delimiter)) {
    if (!isAbsolute(dir)) continue;
    const candidate = join(dir, windows ? "git.exe" : "git");
    try {
      if (!(await stat(candidate)).isFile()) continue;
      if (!windows) await access(candidate, constants.X_OK);
      return await realpath(candidate);
    } catch {
      // not there, or not executable: next entry
    }
  }
  return null;
}

export interface GitCommitResult {
  sha: string;
  message: string;
}

export interface GitClient {
  /** `git` is installed and runs (cached after the first answer). */
  available(): Promise<boolean>;
  /** The folder is inside a Git work tree (false when git is missing). */
  isRepo(root: string): Promise<boolean>;
  status(root: string): Promise<GitStatus>;
  diff(root: string, request: { path: RelativePath | null; staged: boolean }): Promise<GitDiff>;
  /** Current branch, null on a detached HEAD or outside a repository. */
  branch(root: string): Promise<string | null>;
  /**
   * Stages `paths` (or every change under the workspace when "all") then commits. Hooks of the
   * repository run as they would for the user; the caller has obtained the permission first.
   */
  commit(root: string, request: GitCommitRequest): Promise<GitCommitResult>;
}

export interface GitCommitRequest {
  message: string;
  paths: RelativePath[] | "all";
  /**
   * C8 exclusion of the workspace (`IgnoreMatcher.isExcluded`, `.novaignore` loaded). A commit that
   * would include an excluded path is refused before anything is staged.
   */
  isExcluded: (path: RelativePath) => boolean;
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

// ---------------------------------------------------------------------------
// porcelain v2 parsing

const KIND_BY_CODE: Readonly<Record<string, GitChangeKind>> = {
  ".": "unmodified",
  M: "modified",
  T: "type_changed",
  A: "added",
  D: "deleted",
  R: "renamed",
  C: "copied",
  U: "conflicted",
};

function kindOf(code: string | undefined): GitChangeKind {
  return (code !== undefined ? KIND_BY_CODE[code] : undefined) ?? "modified";
}

/** Strips the workspace's prefix inside the repository; null for paths outside the workspace. */
function toWorkspacePath(repoPath: string, prefix: string): RelativePath | null {
  if (!repoPath.startsWith(prefix)) return null;
  const path = repoPath.slice(prefix.length).replace(/\/$/, "");
  return path !== "" && isCanonicalRelativePath(path) ? path : null;
}

/**
 * Parses `git status --porcelain=v2 -z --branch`. `prefix` is `git rev-parse --show-prefix` (the
 * workspace folder inside the repository, "" at the top level, with a trailing "/").
 */
export function parsePorcelainV2(output: string, prefix = ""): Extract<GitStatus, { available: true }> {
  const records = output.split("\0");
  let branch: string | null = null;
  let upstream: string | null = null;
  let ahead: number | null = null;
  let behind: number | null = null;
  const entries: GitStatusEntry[] = [];
  let truncated = false;

  const push = (entry: GitStatusEntry): void => {
    if (entries.length >= GIT_STATUS_MAX_ENTRIES) truncated = true;
    else entries.push(entry);
  };

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] as string;
    if (record === "") continue;
    if (record.startsWith("# ")) {
      const [, key, ...rest] = record.split(" ");
      const value = rest.join(" ");
      if (key === "branch.head") branch = value === "(detached)" ? null : value;
      else if (key === "branch.upstream") upstream = value;
      else if (key === "branch.ab") {
        const match = /^\+(\d+) -(\d+)$/.exec(value);
        if (match) {
          ahead = Number(match[1]);
          behind = Number(match[2]);
        }
      }
      continue;
    }
    const type = record[0];
    if (type === "1" || type === "2" || type === "u") {
      // Fixed field counts before the path: 1 → 8, 2 → 9, u → 10 (paths may contain spaces).
      const fields = type === "1" ? 8 : type === "2" ? 9 : 10;
      const parts = record.split(" ");
      const xy = parts[1] ?? "..";
      const repoPath = parts.slice(fields).join(" ");
      const origRecord = type === "2" ? records[++index] : undefined;
      const path = toWorkspacePath(repoPath, prefix);
      if (path === null) continue;
      const origPath = origRecord === undefined ? null : toWorkspacePath(origRecord, prefix);
      if (type === "u") push({ path, origPath: null, index: "conflicted", worktree: "conflicted" });
      else push({ path, origPath, index: kindOf(xy[0]), worktree: kindOf(xy[1]) });
    } else if (type === "?" || type === "!") {
      const path = toWorkspacePath(record.slice(2), prefix);
      if (path === null) continue;
      const kind: GitChangeKind = type === "?" ? "untracked" : "ignored";
      push({ path, origPath: null, index: kind, worktree: kind });
    }
  }
  // Without an upstream the counts are meaningless (git omits branch.ab); keep them unknown.
  if (upstream === null) {
    ahead = null;
    behind = null;
  }
  return { available: true, branch, upstream, ahead, behind, entries, truncated };
}

// ---------------------------------------------------------------------------

export function createGitClient(options: GitClientOptions = {}): GitClient {
  const timeout = options.timeoutMs ?? 30_000;
  const source = options.env ?? process.env;
  const env: Record<string, string> = {
    ...scrubChildEnv(source, GIT_ENV_NAMES),
    // Never prompt (credentials, editor) and never take the index lock for read-only commands.
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PAGER: "cat",
    LC_ALL: "C",
  };
  let executable: Promise<string | null> | null = null;
  let availability: Promise<boolean> | null = null;

  const gitExecutable = (): Promise<string | null> => (executable ??= options.gitPath ? Promise.resolve(options.gitPath) : findGitExecutable(source));

  /** The executable to run for `root`; a git inside the workspace is never run. */
  const gitFor = async (root: string): Promise<string> => {
    const path = await gitExecutable();
    if (path === null) throw new WorkspaceError("unavailable", "git is not installed (not found on PATH)");
    if (isInsideRoot(root, path)) throw new WorkspaceError("unavailable", "refusing to run a git executable located inside the workspace");
    return path;
  };

  const run = async (root: string, args: string[], extra: { input?: string; env?: Record<string, string> } = {}): Promise<RunResult> => {
    const path = await gitFor(root);
    return new Promise((resolve, reject) => {
      const child = execFile(
        path,
        [...SAFE_CONFIG, ...args],
        { cwd: root, env: { ...env, ...extra.env }, timeout, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
        (error, stdout, stderr) => {
          if (error && typeof error.code !== "number") {
            reject(new WorkspaceError("unavailable", "git could not run"));
            return;
          }
          resolve({ code: typeof error?.code === "number" ? error.code : 0, stdout, stderr });
        },
      );
      if (extra.input !== undefined) child.stdin?.end(extra.input);
    });
  };

  /**
   * Config overrides (GIT_CONFIG_COUNT, no argument parsing of driver names) that disable every
   * filter driver the repository configures, for commands that hash working-tree files. Reading the
   * config runs nothing.
   */
  const noFiltersEnv = async (root: string): Promise<Record<string, string>> => {
    const listed = await run(root, ["config", "--null", "--name-only", "--get-regexp", "^filter\\."]);
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

  const prefixOf = async (root: string): Promise<string | null> => {
    const result = await run(root, ["rev-parse", "--is-inside-work-tree", "--show-prefix"]).catch(() => null);
    if (!result || result.code !== 0) return null;
    const [inside, prefix = ""] = result.stdout.split("\n");
    return inside === "true" ? prefix : null;
  };

  const statusOf = async (root: string, prefix: string, pathspecs: readonly string[]): Promise<Extract<GitStatus, { available: true }>> => {
    const result = await run(root, ["status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all", "--", ...pathspecs], {
      env: await noFiltersEnv(root),
    });
    if (result.code !== 0) throw new WorkspaceError("failed", "git status failed");
    return parsePorcelainV2(result.stdout, prefix);
  };

  const client: GitClient = {
    available() {
      availability ??= gitExecutable().then((path) =>
        path === null
          ? false
          : new Promise<boolean>((resolve) => {
              execFile(path, ["--version"], { env, timeout, windowsHide: true }, (error) => resolve(!error));
            }),
      );
      return availability;
    },

    async isRepo(root) {
      if (!(await client.available())) return false;
      return (await prefixOf(root)) !== null;
    },

    async status(root) {
      if (!(await client.available())) return { available: false };
      const prefix = await prefixOf(root);
      if (prefix === null) return { available: false };
      return statusOf(root, prefix, ["."]);
    },

    async diff(root, { path, staged }) {
      if (path !== null && !isCanonicalRelativePath(path)) throw new WorkspaceError("invalid_path", "invalid relative path");
      const executablePath = await gitFor(root);
      const childEnv = { ...env, ...(await noFiltersEnv(root)) };
      const args = [
        ...SAFE_CONFIG,
        "diff",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        "--relative",
        ...(staged ? ["--cached"] : []),
        "--",
        path ?? ".",
      ];
      // Streamed with a hard cap: a huge diff must not be buffered whole.
      return new Promise<GitDiff>((resolve, reject) => {
        const child = spawn(executablePath, args, { cwd: root, env: childEnv, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;
        const timer = setTimeout(() => child.kill(), timeout);
        child.stdout.on("data", (chunk: Buffer) => {
          if (truncated) return;
          if (size + chunk.length > GIT_DIFF_MAX_BYTES) {
            chunks.push(chunk.subarray(0, GIT_DIFF_MAX_BYTES - size));
            size = GIT_DIFF_MAX_BYTES;
            truncated = true;
            child.kill();
            return;
          }
          chunks.push(chunk);
          size += chunk.length;
        });
        child.on("error", () => {
          clearTimeout(timer);
          reject(new WorkspaceError("unavailable", "git could not run"));
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          if (!truncated && code !== 0) reject(new WorkspaceError("failed", "git diff failed"));
          else resolve({ patch: Buffer.concat(chunks).toString("utf8"), truncated });
        });
      });
    },

    async branch(root) {
      if (!(await client.isRepo(root))) return null;
      const result = await run(root, ["symbolic-ref", "--short", "-q", "HEAD"]);
      return result.code === 0 ? result.stdout.trim() || null : null;
    },

    async commit(root, { message, paths, isExcluded }) {
      const trimmed = message.trim();
      if (trimmed === "") throw new WorkspaceError("invalid_argument", "empty commit message");
      const prefix = (await client.available()) ? await prefixOf(root) : null;
      if (prefix === null) throw new WorkspaceError("unavailable", "not a git repository");
      if (paths !== "all") {
        for (const path of paths) {
          if (!isCanonicalRelativePath(path) || path === "") throw new WorkspaceError("invalid_path", "invalid relative path");
        }
      }
      // C8: what this commit would contain (changes under the pathspecs, staged or not, untracked
      // included) must hold no excluded path. Checked before staging, so a refusal changes nothing.
      const pathspecs = paths === "all" ? ["."] : paths;
      if (paths === "all" || paths.length > 0) {
        const pending = await statusOf(root, prefix, pathspecs);
        if (pending.truncated) {
          throw new WorkspaceError("too_large", `more than ${GIT_STATUS_MAX_ENTRIES} changed files: commit explicit paths instead`);
        }
        const excluded = pending.entries.flatMap((entry) => [entry.path, entry.origPath]).filter((path) => path !== null && isExcluded(path));
        if (excluded.length > 0) {
          const shown = [...new Set(excluded)].slice(0, 5).join(", ");
          throw new WorkspaceError(
            "excluded_path",
            `the commit would include excluded files (${shown}); commit explicit paths that leave them out, or let the user commit them`,
          );
        }
        const added = await run(root, paths === "all" ? ["add", "--all", "--", "."] : ["add", "--", ...paths]);
        if (added.code !== 0) throw new WorkspaceError("failed", "git add failed");
      }
      // Message on stdin: no argument parsing surprises, any length.
      const committed = await run(root, ["commit", "--quiet", "--file", "-"], { input: trimmed });
      if (committed.code !== 0) {
        const output = `${committed.stdout}\n${committed.stderr}`;
        if (/nothing (added )?to commit|no changes added/i.test(output)) {
          throw new WorkspaceError("conflict", "nothing to commit");
        }
        if (/tell me who you are|user\.email|user\.name/i.test(output)) {
          throw new WorkspaceError("failed", "git identity (user.name / user.email) is not configured");
        }
        throw new WorkspaceError("failed", "git commit failed");
      }
      const head = await run(root, ["rev-parse", "HEAD"]);
      return { sha: head.stdout.trim(), message: trimmed };
    },
  };
  return client;
}
