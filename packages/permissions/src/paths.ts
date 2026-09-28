// Path containment (S2): turns a path given by the model or a tool into a canonical workspace-relative
// path, or refuses it. realpath first, then strict containment in the realpath of the root, so a
// symlink pointing outside is refused even when its own name looks harmless. A path that does not
// exist yet (file about to be created) is resolved through its nearest existing ancestor.
import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { isCanonicalRelativePath } from "@nova/shared";

export type ResolveFailure = "invalid_path" | "outside_workspace";

export type ResolvedPath =
  | {
      ok: true;
      /** Absolute real path; stays in main. */
      absolutePath: string;
      /** Canonical relative path ("" = root), what tools, rules and the UI use. */
      relativePath: string;
      /** False when the entry does not exist yet (its parent chain was resolved instead). */
      exists: boolean;
    }
  | { ok: false; reason: ResolveFailure };

const caseInsensitive = process.platform === "win32" || process.platform === "darwin";

function contains(root: string, candidate: string): boolean {
  const a = caseInsensitive ? root.toLowerCase() : root;
  const b = caseInsensitive ? candidate.toLowerCase() : candidate;
  return b === a || b.startsWith(a.endsWith(sep) ? a : a + sep);
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code;
}

class DanglingLinkError extends Error {}

/**
 * realpath of the deepest existing ancestor, with the missing tail appended. A dangling symlink on
 * the way is refused: writing through it would create its (possibly outside) target.
 */
async function realpathAllowMissing(target: string): Promise<{ path: string; exists: boolean }> {
  const tail: string[] = [];
  let current = target;
  for (;;) {
    try {
      const real = await realpath(current);
      return { path: tail.length === 0 ? real : resolve(real, ...tail.reverse()), exists: tail.length === 0 };
    } catch (error) {
      const code = errorCode(error);
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      const linkExists = await lstat(current).then(
        () => true,
        () => false,
      );
      if (linkExists) throw new DanglingLinkError(current);
      const parent = dirname(current);
      if (parent === current) throw error;
      tail.push(basename(current));
      current = parent;
    }
  }
}

/**
 * Resolves `input` (relative to `root`, or absolute) inside the workspace.
 * - `..`, absolute paths and symlinks (even dangling ones) leading outside → `outside_workspace`;
 * - NUL bytes, unreadable entries (ELOOP, EACCES), a root that is gone → `invalid_path`.
 * `root` is the workspace root as stored (absolute); it is realpath'ed here too.
 */
export async function resolveInWorkspace(root: string, input: string): Promise<ResolvedPath> {
  if (input.includes("\0") || !isAbsolute(root)) return { ok: false, reason: "invalid_path" };
  let realRoot: string;
  try {
    realRoot = await realpath(root);
  } catch {
    return { ok: false, reason: "invalid_path" };
  }
  // Lexical check first: `../x` or `/etc/x` is refused without touching the disk outside the root.
  // Absolute inputs may be spelled with the stored root or with its realpath.
  const candidate = isAbsolute(input) ? resolve(input) : resolve(realRoot, input === "" ? "." : input);
  if (!contains(realRoot, candidate) && !contains(resolve(root), candidate)) {
    return { ok: false, reason: "outside_workspace" };
  }
  let resolved: { path: string; exists: boolean };
  try {
    resolved = await realpathAllowMissing(candidate);
  } catch (error) {
    return { ok: false, reason: error instanceof DanglingLinkError ? "outside_workspace" : "invalid_path" };
  }
  if (!contains(realRoot, resolved.path)) return { ok: false, reason: "outside_workspace" };
  const relativePath = relative(realRoot, resolved.path).split(sep).join("/");
  if (!isCanonicalRelativePath(relativePath)) return { ok: false, reason: "invalid_path" };
  return { ok: true, absolutePath: resolved.path, relativePath, exists: resolved.exists };
}
