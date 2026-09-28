// Small in-memory AtelierClient for quick open / project search tests: files in a map, a settable
// search.files/search.text answer, and a write that honors expectedHash like main.
import type {
  CheckpointCreateRequest,
  FileContent,
  FileSearchResult,
  FileWriteRequest,
  FileWriteResult,
  SearchQuery,
  SearchResult,
} from "@nova/shared";
import { NovaIpcError } from "@nova/shared";
import type { AtelierClient } from "../../state/workspace-slice";

export const SEARCH_WORKSPACE_ID = "3f2c1a6e-8b4d-4e7a-9c1f-0a2b3c4d5e6f";

/** Deterministic 64-hex version token (not a real SHA-256; only equality matters in tests). */
export function fakeHash(content: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let index = 0; index < content.length; index += 1) {
    const code = content.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + code, 0x5bd1e995) >>> 0;
  }
  return `${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`.repeat(4);
}

const unavailable = (): Promise<never> =>
  Promise.reject(new NovaIpcError({ code: "unavailable", message: "not in this fake" }));

export interface SearchFake {
  client: AtelierClient;
  disk: Map<string, string>;
  writes: FileWriteRequest[];
  textQueries: SearchQuery[];
  fileQueries: string[];
  /** Answer of search.files; default: substring match over the disk paths. */
  filesAnswer: ((query: string) => Promise<FileSearchResult>) | null;
  /** Answer of search.text; default: JS regex per line over the disk. */
  textAnswer: ((query: SearchQuery) => Promise<SearchResult>) | null;
  /** Paths whose next write answers `conflict` (another program wrote first). */
  conflictOnWrite: Set<string>;
  /** Restore points created (project replace). */
  checkpoints: CheckpointCreateRequest[];
}

function readOf(disk: Map<string, string>, path: string): FileContent {
  const content = disk.get(path);
  if (content === undefined) throw new NovaIpcError({ code: "not_found", message: path });
  return { path, content, hash: fakeHash(content), size: content.length, binary: false, tooLarge: false, eol: "lf" };
}

export function createSearchFake(files: Record<string, string>): SearchFake {
  const disk = new Map(Object.entries(files));
  const fake: SearchFake = {
    client: undefined as unknown as AtelierClient,
    disk,
    writes: [],
    textQueries: [],
    fileQueries: [],
    filesAnswer: null,
    textAnswer: null,
    conflictOnWrite: new Set(),
    checkpoints: [],
  };

  const searchText = (query: SearchQuery): SearchResult => {
    const flags = query.caseSensitive ? "g" : "gi";
    const source = query.isRegex ? query.pattern : query.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(query.wholeWord ? `\\b(?:${source})\\b` : source, flags);
    const matches: SearchResult["matches"] = [];
    for (const [path, content] of [...disk].sort(([a], [b]) => a.localeCompare(b))) {
      content.split("\n").forEach((lineText, index) => {
        const ranges = [...lineText.matchAll(regex)].map((match) => ({
          start: match.index,
          end: match.index + match[0].length,
        }));
        if (ranges.length > 0) matches.push({ path, line: index + 1, lineText, ranges });
      });
    }
    return { matches, truncated: false, durationMs: 1 };
  };

  fake.client = {
    workspace: {
      open: unavailable,
      recent: unavailable,
      facts: unavailable,
      close: unavailable,
      setInstructionConsent: unavailable,
      reopen: unavailable,
      getEditorState: unavailable,
      setEditorState: unavailable,
    },
    files: {
      list: () => Promise.resolve([]),
      read: ({ path }) => Promise.resolve().then(() => readOf(disk, path)),
      write: (request): Promise<FileWriteResult> => {
        fake.writes.push(request);
        const current = disk.get(request.path);
        const currentHash = current === undefined ? null : fakeHash(current);
        if (fake.conflictOnWrite.delete(request.path) || currentHash !== request.expectedHash) {
          return Promise.resolve({ status: "conflict", path: request.path, currentHash });
        }
        disk.set(request.path, request.content);
        return Promise.resolve({
          status: "written",
          path: request.path,
          hash: fakeHash(request.content),
          size: request.content.length,
        });
      },
      create: unavailable,
      move: unavailable,
      trash: unavailable,
      onEvent: () => () => undefined,
    },
    search: {
      text: (query) => {
        fake.textQueries.push(query);
        return fake.textAnswer ? fake.textAnswer(query) : Promise.resolve(searchText(query));
      },
      files: ({ query }) => {
        fake.fileQueries.push(query);
        if (fake.filesAnswer) return fake.filesAnswer(query);
        const paths = [...disk.keys()].filter((path) => path.toLowerCase().includes(query.toLowerCase()));
        return Promise.resolve({ paths, truncated: false });
      },
    },
    git: {
      status: () => Promise.resolve({ available: false }),
      diff: unavailable,
    },
    checkpoints: {
      create: (request) => {
        fake.checkpoints.push(request);
        return Promise.resolve({
          id: `00000000-0000-4000-8000-${String(fake.checkpoints.length).padStart(12, "0")}`,
          workspaceId: request.workspaceId,
          missionId: null,
          label: request.label,
          reason: request.reason,
          createdAt: 1,
          files: [],
        });
      },
    },
  };
  return fake;
}
