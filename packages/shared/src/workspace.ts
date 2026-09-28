// Workspace (opened project folder), its detected facts, files, search and checkpoints.
// Paths are always workspace-relative (see ./paths); the absolute root never leaves main except
// as the display-only `displayPath`.
import { z } from "zod";
import {
  ContentHashSchema,
  GlobPatternSchema,
  RelativeEntryPathSchema,
  RelativePathSchema,
  type ContentHash,
  type RelativePath,
} from "./paths";
import type { PermissionProfile } from "./permissions";

const entityId = z.uuid();

// ---------------------------------------------------------------------------
// Workspace

/** D10: project instruction files (AGENTS.md, CLAUDE.md, .cursorrules) are read only once allowed. */
export type InstructionFilesConsent = "allowed" | "denied";

export interface Workspace {
  id: string;
  /** Folder name (basename of the root). */
  name: string;
  /** Root shown to the user, home-abbreviated (`~/code/app`). Display only: never sent back. */
  displayPath: string;
  permissionProfile: PermissionProfile;
  /** null = not asked yet for this project (D10). */
  instructionFilesConsent: InstructionFilesConsent | null;
  createdAt: number;
  lastOpenedAt: number;
}

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun" | "pip" | "poetry" | "uv" | "cargo" | "go";

export type TestRunnerName = "vitest" | "jest" | "pytest" | "cargo" | "go" | "other";

/** A command as argv (never a shell string): executed without a shell by run_command/run_tests. */
export type CommandArgv = string[];

/** Stack detected from marker files (package.json scripts, pyproject.toml, Cargo.toml, go.mod…). */
export interface WorkspaceFacts {
  workspaceId: string;
  detectedAt: number;
  /** null = unknown (no lockfile or marker found). */
  packageManager: PackageManager | null;
  /** Lowercase identifiers: `typescript`, `javascript`, `python`, `rust`, `go`, `html`… */
  languages: string[];
  /** Lowercase identifiers: `vite`, `react`, `next`, `vue`, `svelte`, `django`, `fastapi`… */
  frameworks: string[];
  testRunner: { name: TestRunnerName; command: CommandArgv } | null;
  devCommand: CommandArgv | null;
  buildCommand: CommandArgv | null;
  /** The root is inside a Git work tree (and `git` is installed). */
  git: boolean;
  /** Instruction files present at the root (AGENTS.md, CLAUDE.md, .cursorrules). Presence only. */
  instructionFiles: RelativePath[];
}

export const WorkspaceIdRequestSchema = z.object({ workspaceId: entityId });
export const WorkspaceRecentRequestSchema = z.object({ limit: z.int().min(1).max(50) });
export const WorkspaceFactsRequestSchema = z.object({ workspaceId: entityId, refresh: z.boolean() });
export const WorkspaceConsentRequestSchema = z.object({
  workspaceId: entityId,
  consent: z.enum(["allowed", "denied"]),
});
export type WorkspaceIdRequest = z.infer<typeof WorkspaceIdRequestSchema>;
export type WorkspaceRecentRequest = z.infer<typeof WorkspaceRecentRequestSchema>;
export type WorkspaceFactsRequest = z.infer<typeof WorkspaceFactsRequestSchema>;
export type WorkspaceConsentRequest = z.infer<typeof WorkspaceConsentRequestSchema>;

// ---------------------------------------------------------------------------
// Files

export type FileEntryKind = "file" | "directory" | "symlink";

export interface FileEntry {
  path: RelativePath;
  name: string;
  kind: FileEntryKind;
  /** Bytes; null for directories or when unknown. */
  size: number | null;
  mtimeMs: number | null;
  /** Matched by .gitignore / .novaignore (shown greyed, not hidden). */
  ignored: boolean;
  /** Symlink resolving outside the workspace: listed, never followed (S2). */
  outsideWorkspace: boolean;
}

/** Files above this size open read-only (content not sent) — E2. */
export const FILE_EDIT_MAX_BYTES = 5 * 1024 * 1024;

export interface FileContent {
  path: RelativePath;
  /** UTF-8 text; null when `binary` or `tooLarge`. */
  content: string | null;
  /** SHA-256 of the bytes on disk: the version token for conflict detection. */
  hash: ContentHash;
  size: number;
  binary: boolean;
  tooLarge: boolean;
  /** Dominant line ending, null when the file has no line break. */
  eol: "lf" | "crlf" | null;
}

export const FilesListRequestSchema = z.object({ workspaceId: entityId, path: RelativePathSchema });
export const FilesReadRequestSchema = z.object({ workspaceId: entityId, path: RelativeEntryPathSchema });

/**
 * Write with optimistic concurrency: `expectedHash` is the hash the writer last saw.
 * null = the file must not exist yet. A mismatch never overwrites: the result is `conflict`.
 */
export const FileWriteRequestSchema = z.object({
  workspaceId: entityId,
  path: RelativeEntryPathSchema,
  content: z.string().max(FILE_EDIT_MAX_BYTES),
  expectedHash: ContentHashSchema.nullable(),
  /**
   * Restore point of a multi-file user change (project replace, E4) created with
   * `checkpoints.create`: the previous content is stored in it before the write. Absent = plain save.
   */
  checkpointId: entityId.nullable().optional(),
});

export type FileWriteResult =
  | { status: "written"; path: RelativePath; hash: ContentHash; size: number }
  | { status: "conflict"; path: RelativePath; currentHash: ContentHash | null };

export const FilesCreateRequestSchema = z.object({
  workspaceId: entityId,
  path: RelativeEntryPathSchema,
  kind: z.enum(["file", "directory"]),
});
export const FilesMoveRequestSchema = z.object({
  workspaceId: entityId,
  from: RelativeEntryPathSchema,
  to: RelativeEntryPathSchema,
});
/** Moves to the OS trash (`shell.trashItem`), never a permanent delete. */
export const FilesTrashRequestSchema = z.object({ workspaceId: entityId, path: RelativeEntryPathSchema });

export type FilesListRequest = z.infer<typeof FilesListRequestSchema>;
export type FilesReadRequest = z.infer<typeof FilesReadRequestSchema>;
export type FileWriteRequest = z.infer<typeof FileWriteRequestSchema>;
export type FilesCreateRequest = z.infer<typeof FilesCreateRequestSchema>;
export type FilesMoveRequest = z.infer<typeof FilesMoveRequestSchema>;
export type FilesTrashRequest = z.infer<typeof FilesTrashRequestSchema>;

export interface FileChange {
  kind: "created" | "changed" | "deleted";
  path: RelativePath;
  isDirectory: boolean;
}

/**
 * Pushed on `files.onEvent` for every open workspace (debounced batches from the fs-worker).
 * `overflow`: too many changes at once; the renderer re-lists what it shows.
 */
export type FilesEvent =
  | { type: "changes"; workspaceId: string; changes: FileChange[] }
  | { type: "overflow"; workspaceId: string };

// ---------------------------------------------------------------------------
// Search (ripgrep --json in the fs-worker)

export const SearchTextRequestSchema = z.object({
  workspaceId: entityId,
  pattern: z.string().min(1).max(1_000),
  isRegex: z.boolean(),
  caseSensitive: z.boolean(),
  wholeWord: z.boolean(),
  include: z.array(GlobPatternSchema).max(50),
  exclude: z.array(GlobPatternSchema).max(50),
  maxResults: z.int().min(1).max(10_000),
});
export type SearchQuery = z.infer<typeof SearchTextRequestSchema>;

export interface SearchMatch {
  path: RelativePath;
  /** 1-based line number. */
  line: number;
  /** Line text, truncated to 500 characters. */
  lineText: string;
  /** UTF-16 offsets within `lineText` (ripgrep byte offsets converted by the worker). */
  ranges: { start: number; end: number }[];
}

export interface SearchResult {
  matches: SearchMatch[];
  /** More matches exist than `maxResults`. */
  truncated: boolean;
  durationMs: number;
}

/** Quick open (Ctrl+P): fuzzy match on relative paths from the worker's file index. */
export const SearchFilesRequestSchema = z.object({
  workspaceId: entityId,
  query: z.string().max(500),
  limit: z.int().min(1).max(500),
});
export type FileSearchQuery = z.infer<typeof SearchFilesRequestSchema>;
export interface FileSearchResult {
  paths: RelativePath[];
  truncated: boolean;
}

// ---------------------------------------------------------------------------
// Checkpoints (A10): content-addressed snapshots in dataDir/checkpoints/objects/<sha256>.

export type CheckpointReason = "tool_write" | "user_replace" | "before_restore" | "manual";

export interface CheckpointFile {
  checkpointId: string;
  path: RelativePath;
  /** Content before the change; null = the file did not exist. */
  beforeHash: ContentHash | null;
  /** Content written by the change; null = the change deleted the file. */
  afterHash: ContentHash | null;
  /** Hash of the user's version seen just before the write, when it differed (conflict evidence). */
  userHashSeen: ContentHash | null;
}

export interface Checkpoint {
  id: string;
  workspaceId: string;
  missionId: string | null;
  label: string;
  reason: CheckpointReason;
  createdAt: number;
  files: CheckpointFile[];
}

export const CheckpointsListRequestSchema = z.object({
  workspaceId: entityId,
  missionId: entityId.nullable(),
  limit: z.int().min(1).max(500),
});
export const CheckpointRestoreFileRequestSchema = z.object({
  checkpointId: entityId,
  path: RelativeEntryPathSchema,
});
export const CheckpointRestoreAllRequestSchema = z.object({ checkpointId: entityId });
/** A user restore point (project replace, manual); agent checkpoints are created by main only. */
export const CheckpointCreateRequestSchema = z.object({
  workspaceId: entityId,
  label: z.string().trim().min(1).max(200),
  reason: z.enum(["user_replace", "manual"]),
});
export const CheckpointMergeRequestSchema = z.object({
  checkpointId: entityId,
  path: RelativeEntryPathSchema,
});
export const CheckpointApplyMergeRequestSchema = z.object({
  checkpointId: entityId,
  path: RelativeEntryPathSchema,
  merged: z.string().max(FILE_EDIT_MAX_BYTES),
  /** Hash the proposal was computed against; the write is refused (`conflict`) if the file changed since. */
  expectedHash: ContentHashSchema.nullable(),
});
export type CheckpointsListRequest = z.infer<typeof CheckpointsListRequestSchema>;
export type CheckpointCreateRequest = z.infer<typeof CheckpointCreateRequestSchema>;
export type CheckpointMergeRequest = z.infer<typeof CheckpointMergeRequestSchema>;
export type CheckpointApplyMergeRequest = z.infer<typeof CheckpointApplyMergeRequestSchema>;
export type CheckpointRestoreFileRequest = z.infer<typeof CheckpointRestoreFileRequestSchema>;
export type CheckpointRestoreAllRequest = z.infer<typeof CheckpointRestoreAllRequestSchema>;

/**
 * Restoring compares the file's current hash with the checkpoint's `afterHash`: equal → restored;
 * different → the user changed it since, nothing is written (`conflict`) and the UI offers a merge.
 */
export type RestoreFileResult =
  | { status: "restored"; path: RelativePath; checkpointId: string }
  | { status: "conflict"; path: RelativePath; currentHash: ContentHash | null; expectedHash: ContentHash | null };

/**
 * Restore met a file the user changed since: the agent's change is undone ON TOP of the user's
 * version (three-way). `clean` = ready to apply; `conflicting` = the three texts, to merge by hand.
 */
export type MergeProposal =
  | { status: "clean"; path: RelativePath; currentHash: ContentHash | null; merged: string }
  | {
      status: "conflicting";
      path: RelativePath;
      currentHash: ContentHash | null;
      /** Text the agent wrote (common base), the user's current text, the checkpoint's text. */
      base: string | null;
      current: string | null;
      target: string | null;
    };

export interface RestoreAllResult {
  /** Checkpoint taken before restoring, so the restore itself can be undone. */
  safetyCheckpointId: string | null;
  results: RestoreFileResult[];
}

// ---------------------------------------------------------------------------
// Editor session (Pr3): tabs, pinned tabs, active tab and scroll per workspace (paths only).

export const EditorSessionSnapshotSchema = z.object({
  version: z.literal(1),
  tabs: z.array(z.object({ path: RelativeEntryPathSchema, pinned: z.boolean() })).max(200),
  activePath: RelativeEntryPathSchema.nullable(),
  /** Scroll offsets in CSS pixels, by path. */
  scroll: z.record(z.string().max(4_096), z.number().min(0).max(1e9)),
});
export type EditorSessionSnapshot = z.infer<typeof EditorSessionSnapshotSchema>;

export const EditorStateSetRequestSchema = z.object({
  workspaceId: entityId,
  state: EditorSessionSnapshotSchema,
});
export type EditorStateSetRequest = z.infer<typeof EditorStateSetRequestSchema>;
