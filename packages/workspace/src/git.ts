// Git through the system `git` CLI (A5): execFile without a shell, relative paths only.
// Read commands are hardened against repository-controlled code execution: `core.fsmonitor` is
// forced off (a hostile repo config could otherwise run a command on `git status`) and diffs never
// run external diff drivers or textconv filters. NOVA never pushes, fetches or stashes.
import { execFile, spawn } from "node:child_process";
import {
  isCanonicalRelativePath,
  type GitChangeKind,
  type GitDiff,
  type GitStatus,
  type GitStatusEntry,
  type RelativePath,
} from "@nova/shared";
import { WorkspaceError } from "./errors";

export const GIT_STATUS_MAX_ENTRIES = 2_000;
export const GIT_DIFF_MAX_BYTES = 1024 * 1024;

const SAFE_CONFIG = ["-c", "core.fsmonitor=false", "-c", "core.quotepath=off", "-c", "color.ui=false"];

export interface GitClientOptions {
  /** Executable name or absolute path (default `git`, resolved on PATH). */
  gitPath?: string;
  timeoutMs?: number;
  env?: Readonly<Record<string, string | undefined>>;
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
  commit(root: string, request: { message: string; paths: RelativePath[] | "all" }): Promise<GitCommitResult>;
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
  const gitPath = options.gitPath ?? "git";
  const timeout = options.timeoutMs ?? 30_000;
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(options.env ?? process.env)) if (value !== undefined) env[name] = value;
  // Never prompt (credentials, editor) and never take the index lock for read-only commands.
  Object.assign(env, { GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_PAGER: "cat", LC_ALL: "C" });
  let availability: Promise<boolean> | null = null;

  const run = (root: string, args: string[], input?: string): Promise<RunResult> =>
    new Promise((resolve, reject) => {
      const child = execFile(
        gitPath,
        [...SAFE_CONFIG, ...args],
        { cwd: root, env, timeout, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
        (error, stdout, stderr) => {
          if (error && typeof error.code !== "number") {
            reject(new WorkspaceError("unavailable", "git could not run"));
            return;
          }
          resolve({ code: typeof error?.code === "number" ? error.code : 0, stdout, stderr });
        },
      );
      if (input !== undefined) child.stdin?.end(input);
    });

  const prefixOf = async (root: string): Promise<string | null> => {
    const result = await run(root, ["rev-parse", "--is-inside-work-tree", "--show-prefix"]).catch(() => null);
    if (!result || result.code !== 0) return null;
    const [inside, prefix = ""] = result.stdout.split("\n");
    return inside === "true" ? prefix : null;
  };

  const client: GitClient = {
    available() {
      availability ??= new Promise<boolean>((resolve) => {
        execFile(gitPath, ["--version"], { env, timeout, windowsHide: true }, (error) => resolve(!error));
      });
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
      const result = await run(root, ["status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all", "--", "."]);
      if (result.code !== 0) throw new WorkspaceError("failed", "git status failed");
      return parsePorcelainV2(result.stdout, prefix);
    },

    async diff(root, { path, staged }) {
      if (path !== null && !isCanonicalRelativePath(path)) throw new WorkspaceError("invalid_path", "invalid relative path");
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
        const child = spawn(gitPath, args, { cwd: root, env, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
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

    async commit(root, { message, paths }) {
      const trimmed = message.trim();
      if (trimmed === "") throw new WorkspaceError("invalid_argument", "empty commit message");
      if (!(await client.isRepo(root))) throw new WorkspaceError("unavailable", "not a git repository");
      if (paths !== "all") {
        for (const path of paths) {
          if (!isCanonicalRelativePath(path) || path === "") throw new WorkspaceError("invalid_path", "invalid relative path");
        }
      }
      const addArgs = paths === "all" ? ["add", "--all", "--", "."] : ["add", "--", ...paths];
      if (paths === "all" || paths.length > 0) {
        const added = await run(root, addArgs);
        if (added.code !== 0) throw new WorkspaceError("failed", "git add failed");
      }
      // Message on stdin: no argument parsing surprises, any length.
      const committed = await run(root, ["commit", "--quiet", "--file", "-"], trimmed);
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
