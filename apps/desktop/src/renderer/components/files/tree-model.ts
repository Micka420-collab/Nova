// Pure model of the lazy file tree: visible rows and WAI-ARIA tree keyboard navigation.
import type { FileEntry, RelativePath } from "@nova/shared";
import type { DirListing } from "../../state/workspace-slice";

export type RowKind = "file" | "directory" | "symlink" | "loading" | "error";

export interface TreeRow {
  /** Unique key; for placeholder rows `<dir>#loading` / `<dir>#error`. */
  path: RelativePath;
  name: string;
  /** 1-based (aria-level). */
  depth: number;
  kind: RowKind;
  entry: FileEntry | null;
  /** Directories only. */
  isExpanded: boolean;
  /** Directory this row belongs to ("" = root). */
  parent: RelativePath;
}

/** Row focusable by keyboard (placeholders are not). */
export function isFocusable(row: TreeRow): boolean {
  return row.kind !== "loading";
}

export function isDirectoryRow(row: TreeRow): boolean {
  return row.kind === "directory";
}

/** Rows shown for the tree, depth first, only inside expanded directories. */
export function flattenVisibleRows(
  dirs: Record<RelativePath, DirListing>,
  expanded: Record<RelativePath, true>,
): TreeRow[] {
  const rows: TreeRow[] = [];
  const walk = (dir: RelativePath, depth: number): void => {
    const listing = dirs[dir];
    if (!listing) {
      rows.push({ path: `${dir}#loading`, name: "", depth, kind: "loading", entry: null, isExpanded: false, parent: dir });
      return;
    }
    if (listing.status === "error") {
      rows.push({ path: `${dir}#error`, name: "", depth, kind: "error", entry: null, isExpanded: false, parent: dir });
    } else if (listing.status === "loading" && listing.entries.length === 0) {
      rows.push({ path: `${dir}#loading`, name: "", depth, kind: "loading", entry: null, isExpanded: false, parent: dir });
    }
    for (const entry of listing.entries) {
      const isDir = entry.kind === "directory";
      const open = isDir && Boolean(expanded[entry.path]);
      rows.push({ path: entry.path, name: entry.name, depth, kind: entry.kind, entry, isExpanded: open, parent: dir });
      if (open) walk(entry.path, depth + 1);
    }
  };
  walk("", 1);
  return rows;
}

export type TreeKey = "ArrowUp" | "ArrowDown" | "Home" | "End" | "ArrowRight" | "ArrowLeft";

/** Result of a navigation key: move focus, or expand/collapse a directory in place. */
export type TreeMove =
  | { type: "focus"; path: RelativePath }
  | { type: "expand"; path: RelativePath }
  | { type: "collapse"; path: RelativePath }
  | null;

export function nextFocus(rows: TreeRow[], current: RelativePath | null, key: TreeKey): TreeMove {
  const focusable = rows.filter(isFocusable);
  if (focusable.length === 0) return null;
  const index = current === null ? -1 : focusable.findIndex((row) => row.path === current);
  const row = focusable[index];
  const focus = (target: TreeRow | undefined): TreeMove =>
    target && target.path !== current ? { type: "focus", path: target.path } : null;

  switch (key) {
    case "ArrowDown":
      return focus(index < 0 ? focusable[0] : focusable[index + 1]);
    case "ArrowUp":
      return focus(index < 0 ? focusable[0] : focusable[index - 1]);
    case "Home":
      return focus(focusable[0]);
    case "End":
      return focus(focusable[focusable.length - 1]);
    case "ArrowRight": {
      if (!row || !isDirectoryRow(row)) return null;
      if (!row.isExpanded) return { type: "expand", path: row.path };
      const child = focusable[index + 1];
      return child && child.parent === row.path ? focus(child) : null;
    }
    case "ArrowLeft": {
      if (!row) return null;
      if (isDirectoryRow(row) && row.isExpanded) return { type: "collapse", path: row.path };
      if (row.parent === "") return null;
      return focus(focusable.find((item) => item.path === row.parent));
    }
    default:
      return null;
  }
}

/**
 * Type-to-select: the next focusable named row (after `from`, wrapping) whose name starts with
 * `buffer`, case-insensitive. A buffer of one repeated letter cycles through rows with that letter.
 */
export function typeaheadMatch(rows: TreeRow[], from: RelativePath | null, buffer: string): RelativePath | null {
  const named = rows.filter((row) => isFocusable(row) && row.entry !== null);
  if (named.length === 0 || buffer === "") return null;
  const query = buffer.toLocaleLowerCase("fr");
  const repeated = [...query].every((char) => char === query[0]);
  const start = from === null ? -1 : named.findIndex((row) => row.path === from);
  // A growing buffer may still match the current row; a repeated letter moves on.
  const offset = repeated ? 1 : query.length > 1 ? 0 : 1;
  const needle = repeated ? (query[0] ?? "") : query;
  for (let step = 0; step < named.length; step += 1) {
    const row = named[(start + offset + step + named.length) % named.length];
    if (row && row.name.toLocaleLowerCase("fr").startsWith(needle)) return row.path;
  }
  return null;
}

/** Validation of a name typed for a new or renamed entry; returns the French error or null. */
export function nameError(name: string, messages: { empty: string; invalid: string }): string | null {
  const trimmed = name.trim();
  if (trimmed === "") return messages.empty;
  if (trimmed === "." || trimmed === ".." || /[/\\\0]/.test(trimmed)) return messages.invalid;
  return null;
}
