// Workspace confinement (S2): every workspace-relative path is resolved against the realpath of the
// root and must stay inside it. Symlinks are followed only when their target is inside the root.
//
// `root` arguments are always the realpath of the workspace folder (see `canonicalRoot`); the
// registry stores that form, so a lexical prefix check after realpath is exact.
// Known limit (accepted): a check-then-use race (a path swapped for a symlink between the check and
// the operation) is not defended against; the attacker would need write access to the project.
import { lstat, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { isCanonicalRelativePath, type RelativePath } from "@nova/shared";
import { errnoCode, WorkspaceError } from "./errors";

/** Realpath of a folder chosen by the user; refuses files and missing paths. */
export async function canonicalRoot(folder: string): Promise<string> {
  if (!isAbsolute(folder)) throw new WorkspaceError("invalid_path", "workspace root must be absolute");
  let real: string;
  try {
    real = await realpath(folder);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") throw new WorkspaceError("not_found", "workspace folder not found");
    throw error;
  }
  if (!(await stat(real)).isDirectory()) throw new WorkspaceError("not_a_directory", "workspace root is not a folder");
  return real;
}

/**
 * True when `absolute` is `root` itself or below it (both already canonical). "Itself" is decided
 * by `relative`, not string equality: chokidar hands its root back as `C:/w` for a root `C:\w`, or
 * with a trailing separator, and treating that as outside ignored the whole watched tree.
 */
export function isInsideRoot(root: string, absolute: string): boolean {
  const rel = relative(root, absolute);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/** Canonical workspace-relative form of an absolute path, or null when it is outside the root. */
export function toRelativePath(root: string, absolute: string): RelativePath | null {
  if (!isInsideRoot(root, absolute)) return null;
  return relative(root, absolute).split(sep).join("/");
}

function lexicalPath(root: string, path: RelativePath): string {
  if (!isCanonicalRelativePath(path)) throw new WorkspaceError("invalid_path", "invalid relative path");
  return path === "" ? root : join(root, ...path.split("/"));
}

function outside(path: RelativePath): WorkspaceError {
  return new WorkspaceError("outside_workspace", `${path || "."} resolves outside the workspace`);
}

/**
 * Absolute realpath of an EXISTING entry, following symlinks only while they stay inside the root.
 * Throws `not_found`, `outside_workspace` or `invalid_path`.
 */
export async function resolveExisting(root: string, path: RelativePath): Promise<string> {
  const lexical = lexicalPath(root, path);
  let real: string;
  try {
    real = await realpath(lexical);
  } catch (error) {
    const code = errnoCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") throw new WorkspaceError("not_found", `${path} not found`);
    throw error;
  }
  if (!isInsideRoot(root, real)) throw outside(path);
  return real;
}

/**
 * Absolute path of an entry WITHOUT following its last segment (for create, move, trash and writes
 * of new files): the parent directory must exist and resolve inside the root. Refuses the root.
 */
export async function resolveEntry(root: string, path: RelativePath): Promise<string> {
  if (path === "") throw new WorkspaceError("invalid_path", "the workspace root itself is not an entry");
  const lexical = lexicalPath(root, path);
  let parent: string;
  try {
    parent = await realpath(dirname(lexical));
  } catch (error) {
    const code = errnoCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") throw new WorkspaceError("not_found", `parent of ${path} not found`);
    throw error;
  }
  if (!isInsideRoot(root, parent)) throw outside(path);
  return join(parent, basename(lexical));
}

/**
 * Where a write to `path` lands: the realpath of the existing file (an inside symlink is written
 * through, an escaping one refused), or the entry path when nothing exists yet.
 */
export async function resolveWriteTarget(root: string, path: RelativePath): Promise<string> {
  const entry = await resolveEntry(root, path);
  try {
    await lstat(entry);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return entry;
    throw error;
  }
  try {
    return await resolveExisting(root, path);
  } catch (error) {
    // The entry exists but its target does not: a dangling symlink, whose target could be anywhere.
    if (error instanceof WorkspaceError && error.code === "not_found") {
      throw new WorkspaceError("outside_workspace", `${path} is a dangling symlink (not followed)`);
    }
    throw error;
  }
}

/** realpath of the deepest existing ancestor of `absolute`, with the missing tail appended. */
async function realpathOfExistingPrefix(absolute: string): Promise<string> {
  const tail: string[] = [];
  let current = absolute;
  for (;;) {
    try {
      return join(await realpath(current), ...tail.reverse());
    } catch (error) {
      const code = errnoCode(error);
      const parent = dirname(current);
      if ((code !== "ENOENT" && code !== "ENOTDIR") || parent === current) throw error;
      tail.push(basename(current));
      current = parent;
    }
  }
}

/**
 * Every workspace-relative spelling of what an operation on `path` really touches, for C8 checks
 * (an exclusion holds for the file, whatever name leads to it): `path` itself, the entry with its
 * folders resolved (`gitlink/hooks/x` → `.git/hooks/x`, missing folders kept as named) and, when
 * the entry exists, its final target (`notes.txt` → `.env`). Spellings outside the root are left
 * out: confinement refuses those.
 */
export async function resolvedSpellings(root: string, path: RelativePath): Promise<RelativePath[]> {
  const lexical = lexicalPath(root, path);
  const spellings = new Set<RelativePath>([path]);
  if (path === "") return [path];
  const entry = toRelativePath(root, join(await realpathOfExistingPrefix(dirname(lexical)), basename(lexical)));
  if (entry !== null) spellings.add(entry);
  const target = await realpath(lexical).then(
    (real) => toRelativePath(root, real),
    () => null,
  );
  if (target !== null) spellings.add(target);
  return [...spellings];
}

/** Result of classifying a symlink found while listing: its target kind, or outside/dangling. */
export async function classifySymlink(
  root: string,
  absolute: string,
): Promise<{ outsideWorkspace: boolean; targetIsDirectory: boolean }> {
  try {
    const real = await realpath(absolute);
    if (!isInsideRoot(root, real)) return { outsideWorkspace: true, targetIsDirectory: false };
    return { outsideWorkspace: false, targetIsDirectory: (await stat(real)).isDirectory() };
  } catch {
    // Dangling: nothing to follow; shown as a plain symlink.
    return { outsideWorkspace: false, targetIsDirectory: false };
  }
}
