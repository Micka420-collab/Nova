// @nova/workspace — confined filesystem, project facts and checkpoints (E1/E2/E4, A2, A10).
// Runs in the fs-worker (watcher, ripgrep, reads/writes) with main owning the workspace registry.
//
// Contract for the feature implementation:
// - Confinement (S2): every relative path is resolved against the root with realpath; the result
//   must stay inside the root; symlinks leaving it are listed (`outsideWorkspace`) but never followed.
// - Versions: content hash = SHA-256 hex of the bytes on disk; writes require the expected hash
//   (null = must not exist) and never overwrite on mismatch (FileWriteResult `conflict`).
// - Ignore rules: .gitignore + .novaignore via `ignore`; watcher: chokidar, debounced batches
//   (FilesEvent), overflow when a batch is too large.
// - Checkpoints: before a tool write, the previous bytes are stored content-addressed in
//   dataDir/checkpoints/objects/<sha256> and a checkpoint_files row is recorded; restore compares the
//   current hash with afterHash (equal → restore, different → conflict, nothing written).
// - Facts: marker files only (package.json scripts, lockfiles, pyproject.toml, Cargo.toml, go.mod,
//   index.html); unknown stays null.
import type {
  Checkpoint,
  CheckpointReason,
  ContentHash,
  FileContent,
  FileEntry,
  FileWriteResult,
  RelativePath,
  RestoreFileResult,
  SearchQuery,
  SearchResult,
  WorkspaceFacts,
} from "@nova/shared";

export interface ConfinedFs {
  readonly root: string;
  /** Absolute path of a canonical relative path, or null when it escapes the root. */
  resolve(path: RelativePath): Promise<string | null>;
  list(path: RelativePath): Promise<FileEntry[]>;
  read(path: RelativePath): Promise<FileContent>;
  write(path: RelativePath, content: string, expectedHash: ContentHash | null): Promise<FileWriteResult>;
}

export interface FactsDetector {
  detect(root: string, workspaceId: string): Promise<WorkspaceFacts>;
}

export interface TextSearcher {
  search(root: string, query: SearchQuery, signal: AbortSignal): Promise<SearchResult>;
}

export interface CheckpointStore {
  /** Snapshots the current content of `paths` before a change and returns the checkpoint. */
  capture(input: {
    workspaceId: string;
    missionId: string | null;
    label: string;
    reason: CheckpointReason;
    paths: RelativePath[];
  }): Promise<Checkpoint>;
  restoreFile(checkpointId: string, path: RelativePath): Promise<RestoreFileResult>;
}
