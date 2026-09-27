// @nova/workspace — confined filesystem, ignore/exclusion rules, watcher, search, quick-open index,
// project facts, checkpoints, git and C8 secret scanning (E1/E2/E4/E10, A2/A5/A10/A11, C8).
// Pure Node (no Electron): used by the fs-worker (watcher, search, lists, reads, user writes) and by
// main (checkpoints, git, agent file tools).
//
// Invariants:
// - Confinement (S2): workspace-relative canonical paths only; resolved with realpath against the
//   canonical root; symlinks leaving the root are listed (`outsideWorkspace`) but never followed.
// - Versions: content hash = SHA-256 hex of the bytes on disk; writes take the expected hash
//   (null = must not exist) and never overwrite on mismatch (`conflict`).
// - Checkpoints: bytes in dataDir/checkpoints/objects/<sha256> (gzip), rows via `CheckpointIndex`;
//   restore never overwrites a file the user changed since (`conflict` + `proposeMerge`).
// - Facts: marker files only; unknown stays null.
export { canonicalRoot, isInsideRoot, resolveEntry, resolveExisting, resolveWriteTarget, toRelativePath } from "./confine";
export { WorkspaceError, isWorkspaceError, type WorkspaceErrorCode } from "./errors";
export { decodeText, detectEol, hashFile, sha256 } from "./hash";
export {
  ALWAYS_IGNORED_DIRS,
  SENSITIVE_DEFAULT_PATTERNS,
  createIgnoreMatcher,
  type IgnoreMatcher,
} from "./ignore-rules";
export {
  atomicWrite,
  createEntry,
  currentHash,
  describeEntry,
  ensureParentDirectories,
  listDirectory,
  moveEntry,
  readBytesOrNull,
  readWorkspaceFile,
  writeWorkspaceFile,
} from "./files";
export { watchWorkspace, type WatchBatch, type WatchOptions, type WorkspaceWatcher } from "./watcher";
export { SEARCH_LINE_MAX_CHARS, searchText, type TextSearchOptions } from "./search";
export { FILE_INDEX_MAX, FileIndex, fuzzyScore, rankPaths, walkFiles } from "./file-index";
export { INSTRUCTION_FILES, detectWorkspaceFacts, type FactsDetectorOptions } from "./facts";
export { createObjectStore, type ObjectStore, type StoredObject } from "./object-store";
export {
  createCheckpointStore,
  type CheckpointIndex,
  type CheckpointStore,
  type CheckpointStoreDeps,
  type MergeProposal,
  type PendingSnapshot,
  type PurgeReport,
  type RetentionPolicy,
} from "./checkpoints";
export {
  GIT_DIFF_MAX_BYTES,
  GIT_STATUS_MAX_ENTRIES,
  createGitClient,
  parsePorcelainV2,
  type GitClient,
  type GitClientOptions,
  type GitCommitResult,
} from "./git";
export {
  checkOutgoingContent,
  redactSensitive,
  scanForSecrets,
  type OutgoingCheck,
  type SecretFinding,
  type SecretKind,
} from "./sensitive";
export {
  createWorkspaceFileOps,
  type FileChangeOutcome,
  type FileChangeSummary,
  type FileOpsDeps,
  type ReadFileResult,
  type TextEdit,
  type WorkspaceFileOps,
  type WriteOptions,
} from "./file-ops";
