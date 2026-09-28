// Workspace-relative paths as they cross IPC. The renderer only ever sees and sends these; main
// resolves them against the workspace root (realpath + containment, S2) before any disk access.
//
// Canonical form (anything else is REJECTED, never silently normalized, so what was validated is
// exactly what gets used):
// - segments separated by "/" (also on Windows), no backslash, no NUL;
// - no leading or trailing "/", no empty, "." or ".." segment, no drive letter ("C:");
// - "" (empty string) denotes the workspace root;
// - at most 4096 characters, each segment at most 255.
import { z } from "zod";

/** A canonical workspace-relative path (see header). Branded only by documentation, not by type. */
export type RelativePath = string;

export const RELATIVE_PATH_MAX = 4096;
const SEGMENT_MAX = 255;

export function isCanonicalRelativePath(value: string): boolean {
  if (value === "") return true;
  if (value.length > RELATIVE_PATH_MAX) return false;
  if (value.includes("\0") || value.includes("\\")) return false;
  if (/^[a-zA-Z]:/.test(value)) return false;
  return value
    .split("/")
    .every((segment) => segment !== "" && segment !== "." && segment !== ".." && segment.length <= SEGMENT_MAX);
}

/** Relative path, root allowed (""). */
export const RelativePathSchema = z
  .string()
  .max(RELATIVE_PATH_MAX)
  .refine(isCanonicalRelativePath, "chemin relatif invalide");

/** Relative path that names an entry inside the root (not the root itself). */
export const RelativeEntryPathSchema = RelativePathSchema.refine((value) => value !== "", "chemin vide");

/** Joins canonical relative paths (both sides must already be canonical). */
export function joinRelativePath(base: RelativePath, name: string): RelativePath {
  return base === "" ? name : `${base}/${name}`;
}

/** Parent of a canonical relative path ("" for top-level entries and for the root). */
export function parentRelativePath(path: RelativePath): RelativePath {
  const index = path.lastIndexOf("/");
  return index === -1 ? "" : path.slice(0, index);
}

/** Glob pattern used in include/exclude filters (gitignore-like syntax, relative to the root). */
export const GlobPatternSchema = z
  .string()
  .min(1)
  .max(500)
  .refine((value) => !value.includes("\0"), "motif invalide");

/** Lowercase hex SHA-256 of the exact bytes on disk. */
export const ContentHashSchema = z.string().regex(/^[0-9a-f]{64}$/, "empreinte invalide");
export type ContentHash = string;
