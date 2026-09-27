// In-memory AtelierClient for renderer tests (tree, editor, quick open, project search).
// Test-only: never imported by production code (it uses node:crypto for real SHA-256 hashes).
//
// Usage:
//   const fake = createFakeAtelierClient({ "src/app.ts": "export {}\n", "README.md": "# Hi\n" });
//   const store = createAtelierStore(fake.client);
//   await store.getState().explorer.bind(WORKSPACE_ID);
//   fake.disk.set("src/app.ts", "changed");   // external change, emits a `changes` event
//   fake.calls.filter((call) => call.method === "files.write");
//
// Directories are implied by file paths; empty directories can be declared with `options.dirs`.
import { createHash } from "node:crypto";
import {
  FILE_EDIT_MAX_BYTES,
  NovaIpcError,
  parentRelativePath,
  type FileContent,
  type FileEntry,
  type FilesEvent,
  type GitStatus,
  type IpcErrorCode,
  type RelativePath,
  type SearchMatch,
  type Workspace,
} from "@nova/shared";
import type { AtelierClient } from "../../state/workspace-slice";

export const WORKSPACE_ID = "3f0c8a52-6d1e-4b7a-9c2f-5e8d1a4b7c90";

export const TEST_WORKSPACE: Workspace = {
  id: WORKSPACE_ID,
  name: "mon-site",
  displayPath: "~/code/mon-site",
  permissionProfile: "assisted",
  instructionFilesConsent: null,
  createdAt: 1_000,
  lastOpenedAt: 2_000,
};

export function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export interface FakeCall {
  method: string;
  request: unknown;
}

export interface FakeAtelierOptions {
  /** Empty directories (others are implied by file paths). */
  dirs?: string[];
  /** Paths matched by .gitignore (listed greyed). */
  ignored?: string[];
  /** Symlinks resolving outside the workspace (listed, never followed). */
  outside?: string[];
  git?: GitStatus;
  /** Makes a method fail with this code (e.g. `{ "files.list:src": "internal" }` or `{ "files.write": "internal" }`). */
  failures?: Record<string, IpcErrorCode>;
  /** Emit `changes` events automatically after create/move/trash/write (default true). */
  emitOwnChanges?: boolean;
}

export interface FakeDisk {
  get(path: RelativePath): string | undefined;
  /** Writes a file from outside NOVA and emits a `changes` event. */
  set(path: RelativePath, content: string, emit?: boolean): void;
  /** Deletes a file from outside NOVA and emits a `deleted` event. */
  delete(path: RelativePath, emit?: boolean): void;
  paths(): RelativePath[];
}

export interface FakeAtelier {
  client: AtelierClient;
  disk: FakeDisk;
  calls: FakeCall[];
  emit(event: FilesEvent): void;
  setGit(status: GitStatus): void;
  /** Sets or clears (`null`) a failure for a method key (see `FakeAtelierOptions.failures`). */
  fail(key: string, code: IpcErrorCode | null): void;
  callsOf(method: string): unknown[];
}

function fail(code: IpcErrorCode, message: string): never {
  throw new NovaIpcError({ code, message });
}

function nameOf(path: RelativePath): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function eolOf(content: string): FileContent["eol"] {
  const crlf = content.split("\r\n").length - 1;
  const lf = content.split("\n").length - 1 - crlf;
  if (crlf === 0 && lf === 0) return null;
  return crlf > lf ? "crlf" : "lf";
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function createFakeAtelierClient(initial: Record<string, string>, options: FakeAtelierOptions = {}): FakeAtelier {
  const files = new Map<RelativePath, string>(Object.entries(initial));
  const dirs = new Set<RelativePath>(options.dirs ?? []);
  const ignored = new Set(options.ignored ?? []);
  const outside = new Set(options.outside ?? []);
  const failures = new Map(Object.entries(options.failures ?? {}));
  const emitOwn = options.emitOwnChanges ?? true;
  let git: GitStatus = options.git ?? { available: false };
  const listeners = new Set<(event: FilesEvent) => void>();
  const calls: FakeCall[] = [];

  const record = (method: string, request: unknown, key: string = method): void => {
    calls.push({ method, request });
    const code = failures.get(key) ?? failures.get(method);
    if (code) fail(code, `${method} failed (fake)`);
  };
  const emit = (event: FilesEvent): void => {
    for (const listener of listeners) listener(event);
  };
  const changed = (kind: "created" | "changed" | "deleted", path: RelativePath, isDirectory = false): void => {
    emit({ type: "changes", workspaceId: WORKSPACE_ID, changes: [{ kind, path, isDirectory }] });
  };
  const checkWorkspace = (workspaceId: string): void => {
    if (workspaceId !== WORKSPACE_ID) fail("not_found", "unknown workspace");
  };

  const allDirs = (): Set<RelativePath> => {
    const result = new Set<RelativePath>(dirs);
    for (const path of [...files.keys(), ...dirs]) {
      let parent = parentRelativePath(path);
      while (parent !== "") {
        result.add(parent);
        parent = parentRelativePath(parent);
      }
    }
    return result;
  };
  const isDir = (path: RelativePath): boolean => allDirs().has(path);
  const exists = (path: RelativePath): boolean => files.has(path) || isDir(path) || outside.has(path);

  const entryOf = (path: RelativePath): FileEntry => {
    const directory = isDir(path);
    const content = files.get(path);
    return {
      path,
      name: nameOf(path),
      kind: outside.has(path) ? "symlink" : directory ? "directory" : "file",
      size: directory || content === undefined ? null : new TextEncoder().encode(content).length,
      mtimeMs: null,
      ignored: ignored.has(path),
      outsideWorkspace: outside.has(path),
    };
  };

  const contentOf = (path: RelativePath, content: string): FileContent => {
    const size = new TextEncoder().encode(content).length;
    const binary = content.includes("\0");
    const tooLarge = size > FILE_EDIT_MAX_BYTES;
    return {
      path,
      content: binary || tooLarge ? null : content,
      hash: sha256(content),
      size,
      binary,
      tooLarge,
      eol: eolOf(content),
    };
  };

  const client: AtelierClient = {
    workspace: {
      open: async () => {
        record("workspace.open", null);
        return TEST_WORKSPACE;
      },
      recent: async (req) => {
        record("workspace.recent", req);
        return [TEST_WORKSPACE];
      },
      facts: async (req) => {
        record("workspace.facts", req);
        return {
          workspaceId: WORKSPACE_ID,
          detectedAt: 0,
          packageManager: null,
          languages: [],
          frameworks: [],
          testRunner: null,
          devCommand: null,
          buildCommand: null,
          git: git.available,
          instructionFiles: [],
        };
      },
      close: async (req) => {
        record("workspace.close", req);
      },
      setInstructionConsent: async (req) => {
        record("workspace.setInstructionConsent", req);
        return { ...TEST_WORKSPACE, instructionFilesConsent: req.consent };
      },
    },
    files: {
      list: async (req) => {
        record("files.list", req, `files.list:${req.path}`);
        checkWorkspace(req.workspaceId);
        if (req.path !== "" && !isDir(req.path)) fail("not_found", "no such directory");
        const children = new Set<RelativePath>();
        for (const path of [...files.keys(), ...allDirs(), ...outside]) {
          if (path !== req.path && parentRelativePath(path) === req.path) children.add(path);
        }
        return [...children]
          .map(entryOf)
          .sort((a, b) => {
            const rank = (entry: FileEntry): number => (entry.kind === "directory" ? 0 : 1);
            return rank(a) - rank(b) || a.name.localeCompare(b.name);
          });
      },
      read: async (req) => {
        record("files.read", req, `files.read:${req.path}`);
        checkWorkspace(req.workspaceId);
        const content = files.get(req.path);
        if (content === undefined) fail("not_found", "no such file");
        return contentOf(req.path, content);
      },
      write: async (req) => {
        record("files.write", req, `files.write:${req.path}`);
        checkWorkspace(req.workspaceId);
        const current = files.get(req.path);
        const currentHash = current === undefined ? null : sha256(current);
        if (currentHash !== req.expectedHash) return { status: "conflict", path: req.path, currentHash };
        files.set(req.path, req.content);
        if (emitOwn) changed(current === undefined ? "created" : "changed", req.path);
        return { status: "written", path: req.path, hash: sha256(req.content), size: new TextEncoder().encode(req.content).length };
      },
      create: async (req) => {
        record("files.create", req, `files.create:${req.path}`);
        checkWorkspace(req.workspaceId);
        if (exists(req.path)) fail("conflict", "already exists");
        if (req.kind === "directory") dirs.add(req.path);
        else files.set(req.path, "");
        if (emitOwn) changed("created", req.path, req.kind === "directory");
        return entryOf(req.path);
      },
      move: async (req) => {
        record("files.move", req, `files.move:${req.from}`);
        checkWorkspace(req.workspaceId);
        if (!exists(req.from)) fail("not_found", "no such entry");
        if (exists(req.to)) fail("conflict", "target exists");
        const directory = isDir(req.from);
        const prefix = `${req.from}/`;
        for (const [path, content] of [...files]) {
          if (path === req.from || path.startsWith(prefix)) {
            files.delete(path);
            files.set(req.to + path.slice(req.from.length), content);
          }
        }
        for (const dir of [...dirs]) {
          if (dir === req.from || dir.startsWith(prefix)) {
            dirs.delete(dir);
            dirs.add(req.to + dir.slice(req.from.length));
          }
        }
        if (emitOwn) {
          emit({
            type: "changes",
            workspaceId: WORKSPACE_ID,
            changes: [
              { kind: "deleted", path: req.from, isDirectory: directory },
              { kind: "created", path: req.to, isDirectory: directory },
            ],
          });
        }
        return entryOf(req.to);
      },
      trash: async (req) => {
        record("files.trash", req, `files.trash:${req.path}`);
        checkWorkspace(req.workspaceId);
        if (!exists(req.path)) fail("not_found", "no such entry");
        const directory = isDir(req.path);
        const prefix = `${req.path}/`;
        for (const path of [...files.keys()]) if (path === req.path || path.startsWith(prefix)) files.delete(path);
        for (const dir of [...dirs]) if (dir === req.path || dir.startsWith(prefix)) dirs.delete(dir);
        if (emitOwn) changed("deleted", req.path, directory);
      },
      onEvent: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    search: {
      text: async (req) => {
        record("search.text", req);
        checkWorkspace(req.workspaceId);
        const source = req.isRegex ? req.pattern : escapeRegExp(req.pattern);
        const pattern = new RegExp(req.wholeWord ? `\\b(?:${source})\\b` : source, req.caseSensitive ? "g" : "gi");
        const matches: SearchMatch[] = [];
        let truncated = false;
        for (const path of [...files.keys()].sort()) {
          const lines = (files.get(path) ?? "").split(/\r?\n/);
          lines.forEach((lineText, index) => {
            const ranges = [...lineText.matchAll(pattern)]
              .filter((match) => match[0] !== "")
              .map((match) => ({ start: match.index, end: match.index + match[0].length }));
            if (ranges.length === 0) return;
            if (matches.length >= req.maxResults) truncated = true;
            else matches.push({ path, line: index + 1, lineText: lineText.slice(0, 500), ranges });
          });
        }
        return { matches, truncated, durationMs: 1 };
      },
      files: async (req) => {
        record("search.files", req);
        checkWorkspace(req.workspaceId);
        const query = req.query.toLowerCase();
        const all = [...files.keys()].filter((path) => path.toLowerCase().includes(query)).sort();
        return { paths: all.slice(0, req.limit), truncated: all.length > req.limit };
      },
    },
    git: {
      status: async (req) => {
        record("git.status", req);
        return git;
      },
      diff: async (req) => {
        record("git.diff", req);
        return { patch: "", truncated: false };
      },
    },
  };

  return {
    client,
    calls,
    emit,
    setGit: (status) => {
      git = status;
    },
    fail: (key, code) => {
      if (code) failures.set(key, code);
      else failures.delete(key);
    },
    callsOf: (method) => calls.filter((call) => call.method === method).map((call) => call.request),
    disk: {
      get: (path) => files.get(path),
      set(path, content, doEmit = true) {
        const existed = files.has(path);
        files.set(path, content);
        if (doEmit) changed(existed ? "changed" : "created", path);
      },
      delete(path, doEmit = true) {
        files.delete(path);
        if (doEmit) changed("deleted", path);
      },
      paths: () => [...files.keys()].sort(),
    },
  };
}
