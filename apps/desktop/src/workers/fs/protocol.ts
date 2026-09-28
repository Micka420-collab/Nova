// Methods of the fs-worker (main ↔ worker), pure types shared by both sides.
//
// Domain refusals (not found, conflict, outside the workspace…) are RESULTS, not worker errors:
// ManagedWorker turns worker errors into `unavailable`, which would hide the real reason. Every
// method therefore answers `FsOutcome<T>`; a thrown error only means the worker itself failed.
// Workspaces are registered by main (`workspace.open`) with their canonical root; a restarted
// worker has none, answers `not_open`, and main registers again before retrying.
import type {
  ContentHash,
  FileContent,
  FileEntry,
  FileSearchQuery,
  FileSearchResult,
  FilesEvent,
  FileWriteResult,
  RelativePath,
  SearchMatch,
  SearchQuery,
  SearchResult,
} from "@nova/shared";
import type { WorkspaceErrorCode } from "@nova/workspace";

export type FsFailureCode = WorkspaceErrorCode | "not_open";

export type FsOutcome<T> = { ok: true; value: T } | { ok: false; code: FsFailureCode; message: string };

export interface FsMethods {
  "workspace.open": { params: { workspaceId: string; root: string }; result: null };
  "workspace.close": { params: { workspaceId: string }; result: null };
  "files.list": { params: { workspaceId: string; path: RelativePath }; result: FileEntry[] };
  "files.read": { params: { workspaceId: string; path: RelativePath }; result: FileContent };
  "files.write": {
    params: { workspaceId: string; path: RelativePath; content: string; expectedHash: ContentHash | null };
    result: FileWriteResult;
  };
  "files.create": { params: { workspaceId: string; path: RelativePath; kind: "file" | "directory" }; result: FileEntry };
  "files.move": { params: { workspaceId: string; from: RelativePath; to: RelativePath }; result: FileEntry };
  /** `streamId` (optional): partial matches are pushed as `search.matches` notifications. */
  "search.text": { params: SearchQuery & { streamId?: string }; result: SearchResult };
  "search.cancel": { params: { streamId: string }; result: null };
  "search.files": { params: FileSearchQuery; result: FileSearchResult };
}

export type FsMethod = keyof FsMethods;

/** worker → main notifications. */
export const FS_NOTIFY = {
  filesEvent: "files.event",
  searchMatches: "search.matches",
} as const;

export type FsFilesEventNotify = FilesEvent;
export interface FsSearchMatchesNotify {
  streamId: string;
  matches: SearchMatch[];
}
