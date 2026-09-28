// Test-only in-memory WorkspaceFileApi honoring the L2 contract (@nova/workspace file-ops): hash
// checks on writes (null = must not exist), unique exact edits applied all-or-nothing (LF edits
// match CRLF files), a checkpoint id required on every change, `{ code }` errors like WorkspaceError.
import { createHash } from "node:crypto";
import type { FileEntry, RelativePath } from "@nova/shared";
import type { FileChangeOutcome, WorkspaceFileApi } from "../apis";

export const hashText = (text: string): string => createHash("sha256").update(text).digest("hex");

const fail = (code: string, message: string): Error => Object.assign(new Error(message), { code });

function countLines(text: string): number {
  if (text === "") return 0;
  const breaks = text.split("\n").length - 1;
  return text.endsWith("\n") ? breaks : breaks + 1;
}

export interface MemoryFiles {
  api: WorkspaceFileApi;
  files: Map<RelativePath, string>;
  /** Every accepted change: path and the checkpoint it was recorded in. */
  changes: { path: RelativePath; checkpointId: string }[];
  /** Paths treated as excluded (C8). */
  excluded: Set<RelativePath>;
}

export function memoryFiles(initial: Record<string, string> = {}): MemoryFiles {
  const files = new Map<RelativePath, string>(Object.entries(initial));
  const changes: MemoryFiles["changes"] = [];
  const excluded = new Set<RelativePath>();

  const guard = (path: RelativePath): void => {
    if (excluded.has(path)) throw fail("excluded_path", `${path} is excluded (sensitive or .novaignore)`);
  };

  const commit = (path: RelativePath, before: string | null, next: string, checkpointId: string): FileChangeOutcome => {
    files.set(path, next);
    changes.push({ path, checkpointId });
    const beforeLines = before === null ? [] : before.split("\n");
    const afterLines = next.split("\n");
    const additions = afterLines.filter((line, index) => beforeLines[index] !== line).length;
    const deletions = beforeLines.filter((line, index) => afterLines[index] !== line).length;
    const first = afterLines.findIndex((line, index) => beforeLines[index] !== line);
    return {
      status: "written",
      path,
      hash: hashText(next),
      size: next.length,
      created: before === null,
      additions,
      deletions,
      checkpointId,
      excerpt: first === -1 ? null : { startLine: Math.max(1, first - 2), text: afterLines.slice(Math.max(0, first - 3), first + 3).join("\n") },
    };
  };

  const api: WorkspaceFileApi = {
    async readFile(path, range = {}) {
      guard(path);
      const text = files.get(path);
      if (text === undefined) throw fail("not_found", `${path} not found`);
      const totalLines = countLines(text);
      const startLine = Math.max(1, range.startLine ?? 1);
      const endLine = Math.max(startLine, Math.min(totalLines, range.endLine ?? totalLines));
      const content = text.split("\n").slice(startLine - 1, endLine).join("\n");
      return { path, hash: hashText(text), startLine, endLine, totalLines, content, truncated: false };
    },
    async list(path) {
      const prefix = path === "" ? "" : `${path}/`;
      const names = new Set<string>();
      for (const file of files.keys()) if (file.startsWith(prefix)) names.add(file.slice(prefix.length).split("/")[0] ?? "");
      return [...names].sort().map(
        (name): FileEntry => ({
          path: `${prefix}${name}`,
          name,
          kind: files.has(`${prefix}${name}`) ? "file" : "directory",
          size: files.get(`${prefix}${name}`)?.length ?? null,
          mtimeMs: null,
          ignored: false,
          outsideWorkspace: false,
        }),
      );
    },
    async glob(pattern, limit) {
      const paths = [...files.keys()].filter((path) => path.endsWith(pattern.replace(/^\*\*\/\*/, ""))).sort();
      return { paths: paths.slice(0, limit), truncated: paths.length > limit };
    },
    async searchText(query) {
      const matches = [...files.entries()].flatMap(([path, text]) =>
        text.split("\n").flatMap((lineText, index) => (lineText.includes(query.pattern) ? [{ path, line: index + 1, lineText, ranges: [] }] : [])),
      );
      return { matches: matches.slice(0, query.maxResults), truncated: matches.length > query.maxResults, durationMs: 0 };
    },
    async writeFile(path, content, { expectedHash, checkpointId }) {
      guard(path);
      const current = files.get(path) ?? null;
      const currentHash = current === null ? null : hashText(current);
      if (currentHash !== expectedHash) return { status: "conflict", path, currentHash };
      return commit(path, current, content, checkpointId);
    },
    async editFile(path, edits, { expectedHash, checkpointId }) {
      guard(path);
      const current = files.get(path);
      if (current === undefined) throw fail("not_found", `${path} not found`);
      if (expectedHash !== undefined && hashText(current) !== expectedHash) return { status: "conflict", path, currentHash: hashText(current) };
      let next = current;
      for (const [position, edit] of edits.entries()) {
        const crlf = next.includes("\r\n") && !edit.oldText.includes("\r\n") && !next.includes(edit.oldText);
        const oldText = crlf ? edit.oldText.replace(/\n/g, "\r\n") : edit.oldText;
        const newText = crlf ? edit.newText.replace(/\r?\n/g, "\r\n") : edit.newText;
        const count = next.split(oldText).length - 1;
        if (count === 0) throw fail("not_found", `edit ${position + 1}: oldText not found in ${path}`);
        if (count > 1) throw fail("invalid_argument", `edit ${position + 1}: oldText occurs ${count} times in ${path}; add context to make it unique`);
        next = next.replace(oldText, () => newText);
      }
      return commit(path, current, next, checkpointId);
    },
    async move(from, to, { checkpointId }) {
      guard(from);
      guard(to);
      const text = files.get(from);
      if (text === undefined) throw fail("not_found", `${from} not found`);
      if (files.has(to)) throw fail("already_exists", `${to} already exists`);
      files.delete(from);
      files.set(to, text);
      changes.push({ path: from, checkpointId }, { path: to, checkpointId });
      return { path: to, name: to.split("/").pop() ?? to, kind: "file", size: text.length, mtimeMs: null, ignored: false, outsideWorkspace: false };
    },
    async trash(path, { checkpointId }) {
      guard(path);
      if (!files.delete(path)) throw fail("not_found", `${path} not found`);
      changes.push({ path, checkpointId });
    },
  };
  return { api, files, changes, excluded };
}
