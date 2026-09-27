// Confined file operations (E1/E2, A2): list one level, read with hash, write with optimistic
// concurrency (atomic temp + rename), create, move. Everything takes the canonical root (realpath)
// and workspace-relative paths; nothing here knows about IPC or checkpoints.
import { randomBytes } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  FILE_EDIT_MAX_BYTES,
  joinRelativePath,
  parentRelativePath,
  type ContentHash,
  type FileContent,
  type FileEntry,
  type FileWriteResult,
  type RelativePath,
} from "@nova/shared";
import { classifySymlink, resolveEntry, resolveExisting, resolveWriteTarget } from "./confine";
import { errnoCode, WorkspaceError } from "./errors";
import { decodeText, detectEol, hashFile, hashFileOrNull, sha256 } from "./hash";
import type { IgnoreMatcher } from "./ignore-rules";

const STAT_CONCURRENCY = 64;

async function mapLimited<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function compareEntries(a: FileEntry, b: FileEntry): number {
  const aDir = a.kind === "directory" ? 0 : 1;
  const bDir = b.kind === "directory" ? 0 : 1;
  if (aDir !== bDir) return aDir - bDir;
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }) || (a.name < b.name ? -1 : 1);
}

/**
 * Describes the entry at `absolute` (not followed). Symlinks resolving inside the root take their
 * target's kind; links leaving the root (or dangling) stay `symlink` and are never followed.
 */
export async function describeEntry(
  root: string,
  matcher: IgnoreMatcher,
  path: RelativePath,
  absolute: string,
): Promise<FileEntry | null> {
  let info;
  try {
    info = await lstat(absolute);
  } catch {
    return null; // vanished between readdir and lstat
  }
  let kind: FileEntry["kind"] = info.isDirectory() ? "directory" : info.isSymbolicLink() ? "symlink" : "file";
  let outsideWorkspace = false;
  let size: number | null = info.isFile() ? info.size : null;
  if (info.isSymbolicLink()) {
    const link = await classifySymlink(root, absolute);
    outsideWorkspace = link.outsideWorkspace;
    if (!link.outsideWorkspace) {
      try {
        const target = await stat(absolute);
        kind = target.isDirectory() ? "directory" : "file";
        size = target.isFile() ? target.size : null;
      } catch {
        kind = "symlink"; // dangling
      }
    }
  }
  return {
    path,
    name: basename(absolute),
    kind,
    size,
    mtimeMs: Number.isFinite(info.mtimeMs) ? Math.trunc(info.mtimeMs) : null,
    ignored: matcher.isIgnored(path, kind === "directory"),
    outsideWorkspace,
  };
}

/** One directory level: directories first, then files, by natural name order. */
export async function listDirectory(root: string, matcher: IgnoreMatcher, path: RelativePath): Promise<FileEntry[]> {
  const directory = await resolveExisting(root, path);
  if (!(await stat(directory)).isDirectory()) throw new WorkspaceError("not_a_directory", `${path} is not a folder`);
  await matcher.load(path);
  const names = await readdir(directory);
  const entries = await mapLimited(names, STAT_CONCURRENCY, (name) =>
    describeEntry(root, matcher, joinRelativePath(path, name), join(directory, name)),
  );
  return entries.filter((entry): entry is FileEntry => entry !== null).sort(compareEntries);
}

/** Reads a file with its version hash. Above FILE_EDIT_MAX_BYTES only the hash and size are returned. */
export async function readWorkspaceFile(root: string, path: RelativePath): Promise<FileContent> {
  const absolute = await resolveExisting(root, path);
  const info = await stat(absolute);
  if (!info.isFile()) throw new WorkspaceError("not_a_file", `${path} is not a file`);
  if (info.size > FILE_EDIT_MAX_BYTES) {
    return {
      path,
      content: null,
      hash: await hashFile(absolute),
      size: info.size,
      binary: false,
      tooLarge: true,
      eol: null,
    };
  }
  const bytes = await readFile(absolute);
  const text = decodeText(bytes);
  return {
    path,
    content: text,
    hash: sha256(bytes),
    size: bytes.byteLength,
    binary: text === null,
    tooLarge: false,
    eol: text === null ? null : detectEol(text),
  };
}

/** Bytes of a file inside the root, or null when it does not exist. */
export async function readBytesOrNull(root: string, path: RelativePath): Promise<Buffer | null> {
  try {
    const absolute = await resolveExisting(root, path);
    if (!(await stat(absolute)).isFile()) throw new WorkspaceError("not_a_file", `${path} is not a file`);
    return await readFile(absolute);
  } catch (error) {
    if (error instanceof WorkspaceError && error.code === "not_found") return null;
    throw error;
  }
}

/** Current hash of `path`, null when it does not exist. */
export async function currentHash(root: string, path: RelativePath): Promise<ContentHash | null> {
  try {
    const absolute = await resolveExisting(root, path);
    if (!(await stat(absolute)).isFile()) throw new WorkspaceError("not_a_file", `${path} is not a file`);
    return await hashFileOrNull(absolute);
  } catch (error) {
    if (error instanceof WorkspaceError && error.code === "not_found") return null;
    throw error;
  }
}

/** Writes `bytes` next to `target` then renames over it: readers never see a partial file. */
export async function atomicWrite(target: string, bytes: Uint8Array | string): Promise<void> {
  const temp = join(dirname(target), `.${basename(target)}.nova-${randomBytes(6).toString("hex")}.tmp`);
  let mode: number | undefined;
  try {
    mode = (await stat(target)).mode & 0o7777;
  } catch {
    mode = undefined;
  }
  try {
    await writeFile(temp, bytes, mode === undefined ? { flag: "wx" } : { flag: "wx", mode });
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

/**
 * Writes `content` if the file's current hash is `expectedHash` (null = must not exist).
 * A mismatch never writes: the result is `conflict` with the hash actually on disk.
 */
export async function writeWorkspaceFile(
  root: string,
  path: RelativePath,
  content: string | Uint8Array,
  expectedHash: ContentHash | null,
): Promise<FileWriteResult> {
  const target = await resolveWriteTarget(root, path);
  const existing = await lstat(target).catch((error: unknown) => {
    if (errnoCode(error) === "ENOENT") return null;
    throw error;
  });
  if (existing?.isDirectory()) throw new WorkspaceError("not_a_file", `${path} is a folder`);
  const onDisk = existing ? await hashFile(target) : null;
  if (onDisk !== expectedHash) return { status: "conflict", path, currentHash: onDisk };
  const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : content;
  if (bytes.byteLength > FILE_EDIT_MAX_BYTES) throw new WorkspaceError("too_large", `${path} would exceed 5 MB`);
  await atomicWrite(target, bytes);
  return { status: "written", path, hash: sha256(bytes), size: bytes.byteLength };
}

/** Creates the missing parent folders of `path`, each one confined. */
export async function ensureParentDirectories(root: string, path: RelativePath): Promise<void> {
  const parent = parentRelativePath(path);
  if (parent === "") return;
  const segments = parent.split("/");
  for (let index = 1; index <= segments.length; index += 1) {
    const dir = segments.slice(0, index).join("/");
    const absolute = await resolveEntry(root, dir);
    try {
      await mkdir(absolute);
    } catch (error) {
      if (errnoCode(error) !== "EEXIST") throw error;
    }
  }
}

/** Creates an empty file or a folder; refuses when anything already exists at `path`. */
export async function createEntry(
  root: string,
  matcher: IgnoreMatcher,
  path: RelativePath,
  kind: "file" | "directory",
): Promise<FileEntry> {
  const target = await resolveEntry(root, path);
  try {
    if (kind === "directory") await mkdir(target);
    else await writeFile(target, "", { flag: "wx" });
  } catch (error) {
    if (errnoCode(error) === "EEXIST") throw new WorkspaceError("already_exists", `${path} already exists`);
    throw error;
  }
  const entry = await describeEntry(root, matcher, path, target);
  if (!entry) throw new WorkspaceError("failed", `${path} vanished after creation`);
  return entry;
}

/** Renames/moves an entry inside the workspace; never replaces an existing destination. */
export async function moveEntry(
  root: string,
  matcher: IgnoreMatcher,
  from: RelativePath,
  to: RelativePath,
): Promise<FileEntry> {
  const source = await resolveEntry(root, from);
  const destination = await resolveEntry(root, to);
  try {
    await lstat(source);
  } catch {
    throw new WorkspaceError("not_found", `${from} not found`);
  }
  // Case-only renames on case-insensitive disks: the destination "exists" as the source itself.
  const sameEntry = source.toLowerCase() === destination.toLowerCase() && source !== destination;
  if (!sameEntry) {
    const taken = await lstat(destination).then(
      () => true,
      () => false,
    );
    if (taken) throw new WorkspaceError("already_exists", `${to} already exists`);
  }
  if (`${to}/`.startsWith(`${from}/`)) throw new WorkspaceError("invalid_path", "cannot move a folder into itself");
  await rename(source, destination);
  const entry = await describeEntry(root, matcher, to, destination);
  if (!entry) throw new WorkspaceError("failed", `${to} vanished after the move`);
  return entry;
}
