// In-process file API for the agent tools (A2): read_file, list_dir, glob, search_text,
// write_file, edit_file, move_path, delete_path. Runs wherever the tools execute (main); it is
// NOT a permission check (main evaluates permissions before calling), but it enforces the hard
// guarantees every tool relies on:
// - confinement (S2) and C8 exclusions on every path (`excluded_path`, never read nor written),
//   judged on every spelling of what the call touches: a symlink inside the workspace does not
//   make `.env` or `.git/hooks` reachable under another name. `.novaignore` is read-only here;
// - optimistic concurrency: writes take the hash the agent last saw (null = must not exist) and
//   return `conflict` without writing on mismatch;
// - a checkpoint row for every changed file (A10), taken before the change, including each file
//   of a folder moved or trashed (the review and "restore all" see them);
// - writes to the same path are serialized.
import { lstat, readdir } from "node:fs/promises";
import { join, matchesGlob } from "node:path";
import { diffLines } from "diff";
import {
  FILE_EDIT_MAX_BYTES,
  joinRelativePath,
  TOOL_LIMITS,
  type ContentHash,
  type FileEntry,
  type FileSearchResult,
  type RelativePath,
  type SearchQuery,
  type SearchResult,
} from "@nova/shared";
import { CHECKPOINT_FILE_MAX_BYTES, type CheckpointStore, type PendingSnapshot } from "./checkpoints";
import { resolvedSpellings, resolveEntry, resolveExisting } from "./confine";
import { WorkspaceError } from "./errors";
import { FileIndex } from "./file-index";
import { ensureParentDirectories, listDirectory, moveEntry, readBytesOrNull, writeWorkspaceFile } from "./files";
import { decodeText, sha256 } from "./hash";
import type { IgnoreMatcher } from "./ignore-rules";
import { searchText } from "./search";

export interface FileOpsDeps {
  workspaceId: string;
  /** Canonical root (realpath). */
  root: string;
  matcher: IgnoreMatcher;
  checkpoints: CheckpointStore;
  /** Absolute ripgrep path; null = `searchText` answers `unavailable`. */
  rgPath: string | null;
  /** Moves an absolute path to the OS trash (`shell.trashItem`, main only). */
  trash: (absolute: string) => Promise<void>;
  /** Shared quick-open index when one exists; otherwise walked on first `glob`. */
  fileIndex?: FileIndex;
}

export interface ReadFileResult {
  path: RelativePath;
  hash: ContentHash;
  /** 1-based inclusive range actually returned. */
  startLine: number;
  endLine: number;
  totalLines: number;
  content: string;
  /** The range was cut at TOOL_LIMITS.readMaxChars. */
  truncated: boolean;
}

export interface FileChangeSummary {
  path: RelativePath;
  hash: ContentHash;
  size: number;
  created: boolean;
  additions: number;
  deletions: number;
  checkpointId: string;
  /** Lines around the first change (A2: what the model needs next), 1-based start. */
  excerpt: { startLine: number; text: string } | null;
}

export type FileChangeOutcome =
  | ({ status: "written" } & FileChangeSummary)
  | { status: "conflict"; path: RelativePath; currentHash: ContentHash | null };

export interface TextEdit {
  oldText: string;
  newText: string;
}

export interface WriteOptions {
  /** Hash the agent last saw; null = the file must not exist. */
  expectedHash: ContentHash | null;
  /** Checkpoint of the current mission step (created by the caller with `checkpoints.create`). */
  checkpointId: string;
}

export interface WorkspaceFileOps {
  readFile(path: RelativePath, range?: { startLine?: number; endLine?: number }): Promise<ReadFileResult>;
  list(path: RelativePath): Promise<FileEntry[]>;
  glob(pattern: string, limit: number): Promise<FileSearchResult>;
  searchText(query: Omit<SearchQuery, "workspaceId">, signal?: AbortSignal): Promise<SearchResult>;
  writeFile(path: RelativePath, content: string, options: WriteOptions): Promise<FileChangeOutcome>;
  /** Exact replacements, each `oldText` unique in the file; all applied or none. */
  editFile(
    path: RelativePath,
    edits: readonly TextEdit[],
    options: { expectedHash?: ContentHash; checkpointId: string },
  ): Promise<FileChangeOutcome>;
  move(from: RelativePath, to: RelativePath, options: { checkpointId: string }): Promise<FileEntry>;
  /** To the OS trash, never a permanent delete; the file content is checkpointed first. */
  trash(path: RelativePath, options: { checkpointId: string }): Promise<void>;
}

const EXCERPT_CONTEXT = 3;
/** Folder moves and trashes checkpoint every file inside; above these bounds they are refused. */
export const DIRECTORY_CHECKPOINT_MAX_FILES = 2_000;
const DIRECTORY_CHECKPOINT_MAX_BYTES = 200 * 1024 * 1024;
/** The user's exclusion file (C8): the agent may read it, never change it. */
const NOVAIGNORE = ".novaignore";

function countLines(text: string): number {
  if (text === "") return 0;
  const breaks = text.split("\n").length - 1;
  return text.endsWith("\n") ? breaks : breaks + 1;
}

function changeStats(before: string, after: string): { additions: number; deletions: number; firstLine: number | null } {
  let additions = 0;
  let deletions = 0;
  let line = 1;
  let firstLine: number | null = null;
  for (const part of diffLines(before, after)) {
    const lines = part.count ?? countLines(part.value);
    if (part.added) {
      additions += lines;
      firstLine ??= line;
      line += lines;
    } else if (part.removed) {
      deletions += lines;
      firstLine ??= line;
    } else {
      line += lines;
    }
  }
  return { additions, deletions, firstLine };
}

function excerptAround(text: string, line: number | null): FileChangeSummary["excerpt"] {
  if (line === null) return null;
  const lines = text.split("\n");
  const start = Math.max(1, line - EXCERPT_CONTEXT);
  const end = Math.min(lines.length, line + EXCERPT_CONTEXT * 3);
  return { startLine: start, text: lines.slice(start - 1, end).join("\n").slice(0, 4_000) };
}

function occurrences(haystack: string, needle: string): number {
  let count = 0;
  for (let index = haystack.indexOf(needle); index !== -1; index = haystack.indexOf(needle, index + needle.length)) {
    count += 1;
  }
  return count;
}

export function createWorkspaceFileOps(deps: FileOpsDeps): WorkspaceFileOps {
  const { root, matcher, checkpoints } = deps;
  const index = deps.fileIndex ?? new FileIndex(root, matcher);
  const locks = new Map<string, Promise<unknown>>();

  const withLock = <T>(key: string, task: () => Promise<T>): Promise<T> => {
    const previous = locks.get(key) ?? Promise.resolve();
    const run = previous.then(task, task);
    const tail = run.catch(() => undefined);
    locks.set(key, tail);
    void tail.then(() => {
      if (locks.get(key) === tail) locks.delete(key);
    });
    return run;
  };

  /** C8 for every spelling of what a call on `path` touches (see `resolvedSpellings`). */
  const assertAllowed = async (path: RelativePath, access: "read" | "write"): Promise<void> => {
    await matcher.load("");
    for (const spelling of await resolvedSpellings(root, path)) {
      if (matcher.isExcluded(spelling)) {
        const via = spelling === path ? "" : ` (it leads to ${spelling})`;
        throw new WorkspaceError("excluded_path", `${path} is excluded (sensitive or .novaignore)${via}`);
      }
      if (access === "write" && spelling === NOVAIGNORE) {
        throw new WorkspaceError("excluded_path", `${NOVAIGNORE} holds the user's exclusions: only the user changes it`);
      }
    }
  };

  /**
   * Every file under a folder about to be moved or trashed, each to get its checkpoint row. Refused
   * when the folder holds an excluded path (it would move or vanish unseen) or is too big to record.
   * Symlinks inside go along as links and are not recorded; empty folders are not restored.
   */
  const filesUnder = async (dir: RelativePath): Promise<RelativePath[]> => {
    const files: RelativePath[] = [];
    let bytes = 0;
    const queue: RelativePath[] = [dir];
    while (queue.length > 0) {
      const current = queue.shift() as RelativePath;
      const absolute = await resolveExisting(root, current);
      for (const entry of await readdir(absolute, { withFileTypes: true })) {
        const path = joinRelativePath(current, entry.name);
        if (matcher.isExcluded(path)) {
          throw new WorkspaceError("excluded_path", `${dir} contains ${path}, which is excluded (sensitive or .novaignore): ask the user to handle this folder`);
        }
        if (entry.isDirectory()) queue.push(path);
        else if (entry.isFile()) {
          files.push(path);
          bytes += (await lstat(join(absolute, entry.name))).size;
        }
        if (files.length > DIRECTORY_CHECKPOINT_MAX_FILES || bytes > DIRECTORY_CHECKPOINT_MAX_BYTES) {
          throw new WorkspaceError("too_large", `${dir} is too large to record in a restore point (over ${DIRECTORY_CHECKPOINT_MAX_FILES} files or 200 MB): ask the user`);
        }
      }
    }
    return files;
  };

  /** Snapshots `paths` in order; on any failure the ones taken are discarded. */
  const snapshotAll = async (paths: readonly RelativePath[], checkpointId: string): Promise<PendingSnapshot[]> => {
    const pending: PendingSnapshot[] = [];
    try {
      for (const path of paths) pending.push(await checkpoints.snapshotBeforeWrite({ checkpointId, root, path }));
      return pending;
    } catch (error) {
      for (const snapshot of pending) snapshot.discard();
      throw error;
    }
  };

  /** Checkpointed write of `next` over a file whose current bytes are `before` (null = absent). */
  const commitWrite = async (
    path: RelativePath,
    before: string | null,
    next: string,
    expectedHash: ContentHash | null,
    checkpointId: string,
  ): Promise<FileChangeOutcome> => {
    if (Buffer.byteLength(next, "utf8") > FILE_EDIT_MAX_BYTES) throw new WorkspaceError("too_large", `${path} would exceed 5 MB`);
    const pending = await checkpoints.snapshotBeforeWrite({ checkpointId, root, path, seenHash: expectedHash });
    if (pending.beforeHash !== expectedHash) {
      pending.discard();
      return { status: "conflict", path, currentHash: pending.beforeHash };
    }
    let result;
    try {
      if (pending.beforeHash === null) await ensureParentDirectories(root, path);
      result = await writeWorkspaceFile(root, path, next, expectedHash);
    } catch (error) {
      pending.discard();
      throw error;
    }
    if (result.status === "conflict") {
      pending.discard();
      return result;
    }
    await pending.commit(next);
    const stats = changeStats(before ?? "", next);
    return {
      status: "written",
      path,
      hash: result.hash,
      size: result.size,
      created: before === null,
      additions: stats.additions,
      deletions: stats.deletions,
      checkpointId,
      excerpt: excerptAround(next, stats.firstLine),
    };
  };

  const readText = async (path: RelativePath): Promise<{ text: string; hash: ContentHash } | null> => {
    const bytes = await readBytesOrNull(root, path, FILE_EDIT_MAX_BYTES);
    if (bytes === null) return null;
    const text = decodeText(bytes);
    if (text === null) throw new WorkspaceError("binary", `${path} is a binary file`);
    return { text, hash: sha256(bytes) };
  };

  return {
    async readFile(path, range = {}) {
      await assertAllowed(path, "read");
      const file = await readText(path);
      if (!file) throw new WorkspaceError("not_found", `${path} not found`);
      const lines = file.text.split("\n");
      const totalLines = countLines(file.text);
      const startLine = Math.max(1, range.startLine ?? 1);
      const endLine = Math.max(startLine, Math.min(totalLines, range.endLine ?? totalLines));
      let content = lines.slice(startLine - 1, endLine).join("\n");
      const truncated = content.length > TOOL_LIMITS.readMaxChars;
      if (truncated) content = content.slice(0, TOOL_LIMITS.readMaxChars);
      return { path, hash: file.hash, startLine, endLine, totalLines, content, truncated };
    },

    async list(path) {
      if (path !== "") await assertAllowed(path, "read");
      return listDirectory(root, matcher, path);
    },

    async glob(pattern, limit) {
      const files = await index.all();
      const paths: RelativePath[] = [];
      let truncated = false;
      for (const file of files) {
        if (!matchesGlob(file, pattern) || matcher.isExcluded(file)) continue;
        if (paths.length >= limit) {
          truncated = true;
          break;
        }
        paths.push(file);
      }
      return { paths, truncated: truncated || !index.complete };
    },

    async searchText(query, signal) {
      if (!deps.rgPath) throw new WorkspaceError("unavailable", "ripgrep is not available");
      await matcher.load("");
      return searchText(root, query, {
        rgPath: deps.rgPath,
        ...(signal ? { signal } : {}),
        isExcluded: (path) => matcher.isExcluded(path),
      });
    },

    writeFile(path, content, { expectedHash, checkpointId }) {
      return withLock(path, async () => {
        await assertAllowed(path, "write");
        const before = await readBytesOrNull(root, path, CHECKPOINT_FILE_MAX_BYTES);
        const beforeText = before === null ? null : decodeText(before);
        return commitWrite(path, beforeText ?? (before === null ? null : ""), content, expectedHash, checkpointId);
      });
    },

    editFile(path, edits, { expectedHash, checkpointId }) {
      return withLock(path, async () => {
        await assertAllowed(path, "write");
        if (edits.length === 0) throw new WorkspaceError("invalid_argument", "no edit given");
        const file = await readText(path);
        if (!file) throw new WorkspaceError("not_found", `${path} not found`);
        if (expectedHash !== undefined && file.hash !== expectedHash) {
          return { status: "conflict", path, currentHash: file.hash };
        }
        const crlf = file.text.includes("\r\n");
        let next = file.text;
        for (const [position, edit] of edits.entries()) {
          if (edit.oldText === "") throw new WorkspaceError("invalid_argument", `edit ${position + 1}: oldText is empty`);
          // Models write "\n"; a CRLF file needs the same text with "\r\n" to match.
          const useCrlf = crlf && !edit.oldText.includes("\r\n") && occurrences(next, edit.oldText) === 0;
          const oldText = useCrlf ? edit.oldText.replace(/\n/g, "\r\n") : edit.oldText;
          const newText = useCrlf ? edit.newText.replace(/\r?\n/g, "\r\n") : edit.newText;
          const count = occurrences(next, oldText);
          if (count === 0) throw new WorkspaceError("not_found", `edit ${position + 1}: oldText not found in ${path}`);
          if (count > 1) {
            throw new WorkspaceError("invalid_argument", `edit ${position + 1}: oldText occurs ${count} times in ${path}; add context to make it unique`);
          }
          const at = next.indexOf(oldText);
          next = next.slice(0, at) + newText + next.slice(at + oldText.length);
        }
        return commitWrite(path, file.text, next, file.hash, checkpointId);
      });
    },

    move(from, to, { checkpointId }) {
      // Both paths locked in a fixed order: two opposite moves cannot wait on each other.
      const [first, second] = from < to ? [from, to] : [to, from];
      return withLock(first, () =>
        withLock(second, async () => {
          await assertAllowed(from, "write");
          await assertAllowed(to, "write");
          const info = await lstat(await resolveEntry(root, from)).catch(() => null);
          // Each file is checkpointed as "deleted at its old path, created at its new one" (a
          // folder: every file inside); the new copy reuses the captured bytes, never rereads them.
          const sources = info?.isFile() ? [from] : info?.isDirectory() ? await filesUnder(from) : [];
          const before = await snapshotAll(sources, checkpointId);
          let after: PendingSnapshot[];
          try {
            after = await snapshotAll(
              sources.map((path) => `${to}${path.slice(from.length)}`),
              checkpointId,
            );
          } catch (error) {
            for (const snapshot of before) snapshot.discard();
            throw error;
          }
          let entry: FileEntry;
          try {
            entry = await moveEntry(root, matcher, from, to);
          } catch (error) {
            for (const snapshot of [...before, ...after]) snapshot.discard();
            throw error;
          }
          for (const [position, source] of before.entries()) {
            await source.commit(null);
            await (after[position] as PendingSnapshot).commit({ moved: source });
          }
          return entry;
        }),
      );
    },

    trash(path, { checkpointId }) {
      return withLock(path, async () => {
        await assertAllowed(path, "write");
        const absolute = await resolveEntry(root, path);
        const info = await lstat(absolute).catch(() => null);
        if (!info) throw new WorkspaceError("not_found", `${path} not found`);
        // The content goes into the checkpoint first (a folder: every file inside), then the entry
        // itself is trashed; a symlink is trashed as a link, its target untouched and unrecorded.
        const files = info.isFile() ? [path] : info.isDirectory() ? await filesUnder(path) : [];
        const pending = await snapshotAll(files, checkpointId);
        try {
          await deps.trash(absolute);
        } catch (error) {
          for (const snapshot of pending) snapshot.discard();
          throw error;
        }
        for (const snapshot of pending) await snapshot.commit(null);
      });
    },
  };
}
