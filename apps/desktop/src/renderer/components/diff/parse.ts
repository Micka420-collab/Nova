// Unified diff parsing (`git diff --no-color`) and reverse application, for the change review.
// The diff shown must match the disk: the "before" side is rebuilt from the file read on disk and
// the patch, never from a guess.
import type { DiffLine } from "@nova/ui";

export interface DiffHunkData {
  /** 0-based position of the hunk in its file (ReviewDecision.hunkIndex). */
  index: number;
  /** `@@ -12,7 +12,9 @@` */
  header: string;
  /** Function context after the second `@@` ("" when absent). */
  context: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
  /** The old / new side ends without a final newline ("\ No newline at end of file"). */
  oldNoNewline: boolean;
  newNoNewline: boolean;
}

export type DiffChange = "created" | "modified" | "deleted" | "moved";

export interface DiffFileData {
  /** New path (old path for a deletion). */
  path: string;
  oldPath: string | null;
  change: DiffChange;
  binary: boolean;
  hunks: DiffHunkData[];
  additions: number;
  deletions: number;
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

/** Strips the `a/` / `b/` prefixes and C-style quoting git uses for unusual names. */
function cleanPath(raw: string): string | null {
  let value = raw.trim();
  const tab = value.indexOf("\t");
  if (tab !== -1) value = value.slice(0, tab);
  if (value === "/dev/null") return null;
  if (value.startsWith('"') && value.endsWith('"')) {
    value = value.slice(1, -1).replace(/\\(["\\])/g, "$1");
  }
  if (value.startsWith("a/") || value.startsWith("b/")) value = value.slice(2);
  return value;
}

interface Draft {
  oldPath: string | null;
  newPath: string | null;
  isNew: boolean;
  isDeleted: boolean;
  isRename: boolean;
  binary: boolean;
  hunks: DiffHunkData[];
}

function emptyDraft(): Draft {
  return { oldPath: null, newPath: null, isNew: false, isDeleted: false, isRename: false, binary: false, hunks: [] };
}

function finish(draft: Draft): DiffFileData | null {
  const path = draft.newPath ?? draft.oldPath;
  if (!path) return null;
  const change: DiffChange = draft.isNew
    ? "created"
    : draft.isDeleted
      ? "deleted"
      : draft.isRename || (draft.oldPath !== null && draft.newPath !== null && draft.oldPath !== draft.newPath)
        ? "moved"
        : "modified";
  let additions = 0;
  let deletions = 0;
  for (const hunk of draft.hunks) {
    for (const line of hunk.lines) {
      if (line.kind === "add") additions += 1;
      else if (line.kind === "del") deletions += 1;
    }
  }
  return {
    path,
    oldPath: change === "moved" ? draft.oldPath : null,
    change,
    binary: draft.binary,
    hunks: draft.hunks,
    additions,
    deletions,
  };
}

/** Parses a unified diff with one or more files. Unknown header lines are ignored. */
export function parseUnifiedDiff(patch: string): DiffFileData[] {
  const files: DiffFileData[] = [];
  let draft: Draft | null = null;
  let hunk: DiffHunkData | null = null;
  let oldLine = 0;
  let newLine = 0;
  let last: "context" | "add" | "del" | null = null;

  const flush = () => {
    if (draft) {
      const file = finish(draft);
      if (file) files.push(file);
    }
    draft = null;
    hunk = null;
  };

  const lines = patch.split("\n");
  if (lines.at(-1) === "") lines.pop();
  for (const raw of lines) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.startsWith("diff --git ")) {
      flush();
      draft = emptyDraft();
      const match = /^diff --git (\S+|"[^"]+") (\S+|"[^"]+")$/.exec(line);
      if (match?.[1] && match[2]) {
        draft.oldPath = cleanPath(match[1]);
        draft.newPath = cleanPath(match[2]);
      }
      continue;
    }
    if (hunk) {
      const current: DiffHunkData = hunk;
      const inHunk = oldLine < current.oldStart + current.oldLines || newLine < current.newStart + current.newLines;
      if (line.startsWith("\\")) {
        if (last === "del") current.oldNoNewline = true;
        else if (last === "add") current.newNoNewline = true;
        else if (last === "context") {
          current.oldNoNewline = true;
          current.newNoNewline = true;
        }
        continue;
      }
      if (inHunk && (line.startsWith(" ") || line === "")) {
        current.lines.push({ kind: "context", oldNumber: oldLine, newNumber: newLine, text: line.slice(1) });
        oldLine += 1;
        newLine += 1;
        last = "context";
        continue;
      }
      if (inHunk && line.startsWith("+")) {
        current.lines.push({ kind: "add", oldNumber: null, newNumber: newLine, text: line.slice(1) });
        newLine += 1;
        last = "add";
        continue;
      }
      if (inHunk && line.startsWith("-")) {
        current.lines.push({ kind: "del", oldNumber: oldLine, newNumber: null, text: line.slice(1) });
        oldLine += 1;
        last = "del";
        continue;
      }
    }
    const header = HUNK.exec(line);
    if (header) {
      draft ??= emptyDraft();
      const oldStart = Number(header[1]);
      const newStart = Number(header[3]);
      hunk = {
        index: draft.hunks.length,
        header: line.slice(0, line.indexOf("@@", 2) + 2),
        context: (header[5] ?? "").trim(),
        oldStart,
        oldLines: header[2] === undefined ? 1 : Number(header[2]),
        newStart,
        newLines: header[4] === undefined ? 1 : Number(header[4]),
        lines: [],
        oldNoNewline: false,
        newNoNewline: false,
      };
      draft.hunks.push(hunk);
      oldLine = oldStart;
      newLine = newStart;
      last = null;
      continue;
    }
    if (line.startsWith("--- ")) {
      if (!draft || draft.hunks.length > 0) {
        flush();
        draft = emptyDraft();
      }
      const path = cleanPath(line.slice(4));
      draft.oldPath = path;
      if (path === null) draft.isNew = true;
      hunk = null;
      continue;
    }
    if (line.startsWith("+++ ")) {
      draft ??= emptyDraft();
      const path = cleanPath(line.slice(4));
      draft.newPath = path;
      if (path === null) draft.isDeleted = true;
      continue;
    }
    if (!draft) continue;
    if (line.startsWith("new file mode")) draft.isNew = true;
    else if (line.startsWith("deleted file mode")) draft.isDeleted = true;
    else if (line.startsWith("rename from ")) {
      draft.isRename = true;
      draft.oldPath = line.slice("rename from ".length);
    } else if (line.startsWith("rename to ")) {
      draft.isRename = true;
      draft.newPath = line.slice("rename to ".length);
    } else if (line.startsWith("Binary files ") || line === "GIT binary patch") draft.binary = true;
  }
  flush();
  return files;
}

interface Lines {
  lines: string[];
  finalNewline: boolean;
}

function toLines(text: string): Lines {
  if (text === "") return { lines: [], finalNewline: false };
  const finalNewline = text.endsWith("\n");
  return { lines: (finalNewline ? text.slice(0, -1) : text).split("\n"), finalNewline };
}

function fromLines({ lines, finalNewline }: Lines): string {
  if (lines.length === 0) return "";
  return lines.join("\n") + (finalNewline ? "\n" : "");
}

/**
 * Rebuilds the old text from the new text on disk and the file's hunks (in order). Throws when the
 * new text does not match the hunks (the file changed since the diff was computed).
 */
export function reverseApply(after: string, hunks: readonly DiffHunkData[]): string {
  const source = toLines(after.replace(/\r\n/g, "\n"));
  const out: string[] = [];
  let cursor = 0;
  // An empty new side says nothing about the old one's final newline: text files end with one.
  let finalNewline = source.lines.length === 0 ? true : source.finalNewline;
  for (const hunk of hunks) {
    // With zero new lines, newStart names the line before the (empty) range.
    const start = hunk.newLines === 0 ? hunk.newStart : hunk.newStart - 1;
    if (start < cursor || start > source.lines.length) throw new Error("hunk out of range");
    while (cursor < start) out.push(source.lines[cursor++] ?? "");
    for (const line of hunk.lines) {
      if (line.kind === "del") {
        out.push(line.text);
        continue;
      }
      if (source.lines[cursor] !== line.text) throw new Error("file differs from the diff");
      if (line.kind === "context") out.push(line.text);
      cursor += 1;
    }
    if (hunk.oldNoNewline) finalNewline = false;
    else if (hunk.newNoNewline) finalNewline = true;
  }
  while (cursor < source.lines.length) out.push(source.lines[cursor++] ?? "");
  return fromLines({ lines: out, finalNewline: out.length > 0 && finalNewline });
}

/** Diff of a file that did not exist before (untracked files are absent from `git diff`). */
export function createdFileDiff(path: string, content: string): DiffFileData {
  const { lines, finalNewline } = toLines(content.replace(/\r\n/g, "\n"));
  const hunk: DiffHunkData = {
    index: 0,
    header: `@@ -0,0 +1,${lines.length} @@`,
    context: "",
    oldStart: 0,
    oldLines: 0,
    newStart: 1,
    newLines: lines.length,
    lines: lines.map((text, i) => ({ kind: "add", oldNumber: null, newNumber: i + 1, text })),
    oldNoNewline: false,
    newNoNewline: lines.length > 0 && !finalNewline,
  };
  return {
    path,
    oldPath: null,
    change: "created",
    binary: false,
    hunks: lines.length > 0 ? [hunk] : [],
    additions: lines.length,
    deletions: 0,
  };
}

/** First line of the new file a hunk points at (for "open in the editor"). */
export function hunkTargetLine(hunk: DiffHunkData): number {
  const change = Math.max(0, hunk.lines.findIndex((line) => line.kind !== "context"));
  const target = hunk.lines.slice(change).find((line) => line.newNumber !== null);
  return target?.newNumber ?? Math.max(1, hunk.newStart);
}
