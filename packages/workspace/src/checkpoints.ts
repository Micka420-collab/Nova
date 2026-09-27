// Checkpoints (A10): before a tool write, the previous bytes go to the content-addressed object
// store and a `checkpoint_files` row records before/after hashes. Restoring a file compares its
// current hash with the recorded `afterHash`:
// - equal → the bytes of `beforeHash` are written back (or the file removed when it did not exist);
// - already equal to `beforeHash` → nothing to do (idempotent);
// - anything else → the user changed it since: `conflict`, NOTHING is written. `proposeMerge`
//   then re-applies the inverse of the agent's change on the user's version (jsdiff) when it fits.
// Every restore first snapshots what it overwrites into a `before_restore` checkpoint, so a restore
// can itself be undone.
import { rm } from "node:fs/promises";
import { applyPatch, structuredPatch } from "diff";
import {
  type Checkpoint,
  type CheckpointFile,
  type CheckpointReason,
  type ContentHash,
  type RelativePath,
  type RestoreAllResult,
  type RestoreFileResult,
} from "@nova/shared";
import { resolveEntry, resolveWriteTarget } from "./confine";
import { WorkspaceError } from "./errors";
import { atomicWrite, currentHash, ensureParentDirectories, readBytesOrNull } from "./files";
import { decodeText, sha256 } from "./hash";
import type { ObjectStore } from "./object-store";

/** Persistence of checkpoint rows (implemented by @nova/storage `createCheckpointRepo`). */
export interface CheckpointIndex {
  createCheckpoint(input: {
    workspaceId: string;
    missionId: string | null;
    label: string;
    reason: CheckpointReason;
  }): Checkpoint;
  /** Inserts the row; on an existing (checkpoint, path) keeps the FIRST beforeHash and updates the rest. */
  upsertFile(file: CheckpointFile): void;
  get(checkpointId: string): Checkpoint | null;
  /** Newest first; `missionId` null = every checkpoint of the workspace. */
  list(query: { workspaceId: string; missionId: string | null; limit: number }): Checkpoint[];
  /** Every checkpoint id with its creation time, oldest first (retention). */
  listAges(): { id: string; createdAt: number }[];
  deleteCheckpoints(ids: readonly string[]): void;
  /** Hashes still referenced by any checkpoint file (before, after or user-seen). */
  referencedHashes(): Set<ContentHash>;
}

export interface PendingSnapshot {
  readonly checkpointId: string;
  readonly path: RelativePath;
  /** null = the file did not exist before the write. */
  readonly beforeHash: ContentHash | null;
  /** Records the row once the write happened (`null` = the change deleted the file). */
  commit(after: Uint8Array | string | null): Promise<CheckpointFile>;
  /** The write did not happen: nothing is recorded. */
  discard(): void;
}

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

export interface RetentionPolicy {
  /** Checkpoints older than this are deleted (proposed: 30 days). */
  maxAgeMs: number;
  /** Oldest checkpoints are deleted until the objects fit (proposed: 2 GB). */
  maxBytes: number;
}

export interface PurgeReport {
  deletedCheckpoints: number;
  deletedObjects: number;
  freedBytes: number;
}

export interface CheckpointStore {
  create(input: { workspaceId: string; missionId: string | null; label: string; reason: CheckpointReason }): Checkpoint;
  /**
   * Stores the current bytes of `path` before a write. `seenHash`: the version the writer based its
   * change on; when the disk differs, the disk version is recorded as `userHashSeen`.
   */
  snapshotBeforeWrite(input: {
    checkpointId: string;
    root: string;
    path: RelativePath;
    seenHash?: ContentHash | null;
  }): Promise<PendingSnapshot>;
  get(checkpointId: string): Checkpoint | null;
  list(query: { workspaceId: string; missionId: string | null; limit: number }): Checkpoint[];
  restoreFile(input: { checkpointId: string; root: string; path: RelativePath }): Promise<RestoreFileResult>;
  restoreAll(input: { checkpointId: string; root: string }): Promise<RestoreAllResult>;
  proposeMerge(input: { checkpointId: string; root: string; path: RelativePath }): Promise<MergeProposal>;
  /** Writes an accepted merge, only if the file still has `expectedHash` (else `conflict`). */
  applyMerge(input: {
    checkpointId: string;
    root: string;
    path: RelativePath;
    merged: string;
    expectedHash: ContentHash | null;
  }): Promise<RestoreFileResult>;
  purge(policy: RetentionPolicy): Promise<PurgeReport>;
}

export interface CheckpointStoreDeps {
  index: CheckpointIndex;
  objects: ObjectStore;
  now?: () => number;
  /** Objects younger than this are never garbage-collected (a write may be in flight). */
  gcGraceMs?: number;
}

function toBytes(content: Uint8Array | string): Uint8Array {
  return typeof content === "string" ? Buffer.from(content, "utf8") : content;
}

export function createCheckpointStore(deps: CheckpointStoreDeps): CheckpointStore {
  const { index, objects } = deps;
  const now = deps.now ?? Date.now;
  const gcGraceMs = deps.gcGraceMs ?? 10 * 60_000;
  // Hashes stored for snapshots not yet committed: never collected.
  const inFlight = new Map<ContentHash, number>();
  const hold = (hash: ContentHash): void => void inFlight.set(hash, (inFlight.get(hash) ?? 0) + 1);
  const release = (hash: ContentHash): void => {
    const count = (inFlight.get(hash) ?? 1) - 1;
    if (count <= 0) inFlight.delete(hash);
    else inFlight.set(hash, count);
  };

  const requireCheckpoint = (checkpointId: string): Checkpoint => {
    const checkpoint = index.get(checkpointId);
    if (!checkpoint) throw new WorkspaceError("not_found", "checkpoint not found");
    return checkpoint;
  };
  const requireFile = (checkpoint: Checkpoint, path: RelativePath): CheckpointFile => {
    const file = checkpoint.files.find((entry) => entry.path === path);
    if (!file) throw new WorkspaceError("not_found", `${path} is not part of this checkpoint`);
    return file;
  };

  const store: CheckpointStore = {
    create: (input) => index.createCheckpoint(input),
    get: (checkpointId) => index.get(checkpointId),
    list: (query) => index.list(query),

    async snapshotBeforeWrite({ checkpointId, root, path, seenHash }) {
      requireCheckpoint(checkpointId);
      const bytes = await readBytesOrNull(root, path);
      const beforeHash = bytes === null ? null : await objects.put(bytes);
      if (beforeHash) hold(beforeHash);
      const userHashSeen = seenHash !== undefined && seenHash !== beforeHash ? beforeHash : null;
      let settled = false;
      const settle = (): void => {
        if (settled) throw new WorkspaceError("failed", "snapshot already settled");
        settled = true;
        if (beforeHash) release(beforeHash);
      };
      return {
        checkpointId,
        path,
        beforeHash,
        async commit(after) {
          const afterHash = after === null ? null : await objects.put(toBytes(after));
          settle();
          const file: CheckpointFile = { checkpointId, path, beforeHash, afterHash, userHashSeen };
          index.upsertFile(file);
          return index.get(checkpointId)?.files.find((entry) => entry.path === path) ?? file;
        },
        discard() {
          if (!settled) settle();
        },
      };
    },

    async restoreFile({ checkpointId, root, path }) {
      const checkpoint = requireCheckpoint(checkpointId);
      const file = requireFile(checkpoint, path);
      const safety: { id: string | null } = { id: null };
      return restoreOne(checkpoint, file, root, safety);
    },

    async restoreAll({ checkpointId, root }) {
      const checkpoint = requireCheckpoint(checkpointId);
      const safety: { id: string | null } = { id: null };
      const results: RestoreFileResult[] = [];
      for (const file of checkpoint.files) results.push(await restoreOne(checkpoint, file, root, safety));
      return { safetyCheckpointId: safety.id, results };
    },

    async proposeMerge({ checkpointId, root, path }) {
      const checkpoint = requireCheckpoint(checkpointId);
      const file = requireFile(checkpoint, path);
      const currentBytes = await readBytesOrNull(root, path);
      const current = currentBytes === null ? null : decodeText(currentBytes);
      const hash = currentBytes === null ? null : sha256(currentBytes);
      const textOf = async (objectHash: ContentHash | null): Promise<string | null> =>
        objectHash === null ? null : decodeText(await objects.get(objectHash));
      const base = await textOf(file.afterHash);
      const target = await textOf(file.beforeHash);
      if (base !== null && target !== null && current !== null) {
        // Inverse of the agent's change (after → before), applied to the user's version.
        const undo = structuredPatch(path, path, base, target, "", "", { context: 3 });
        const merged = applyPatch(current, undo);
        if (merged !== false) return { status: "clean", path, currentHash: hash, merged };
      }
      return { status: "conflicting", path, currentHash: hash, base, current, target };
    },

    async applyMerge({ checkpointId, root, path, merged, expectedHash }) {
      const checkpoint = requireCheckpoint(checkpointId);
      requireFile(checkpoint, path);
      const hash = await currentHash(root, path);
      if (hash !== expectedHash) return { status: "conflict", path, currentHash: hash, expectedHash };
      const safety: { id: string | null } = { id: null };
      await snapshotForRestore(checkpoint, root, path, safety, toBytes(merged));
      const target = await resolveWriteTarget(root, path);
      await atomicWrite(target, merged);
      return { status: "restored", path, checkpointId };
    },

    async purge({ maxAgeMs, maxBytes }) {
      const report: PurgeReport = { deletedCheckpoints: 0, deletedObjects: 0, freedBytes: 0 };
      const ages = index.listAges();
      const cutoff = now() - maxAgeMs;
      const expired = ages.filter((entry) => entry.createdAt < cutoff).map((entry) => entry.id);
      if (expired.length > 0) index.deleteCheckpoints(expired);
      report.deletedCheckpoints += expired.length;
      await collect(report);

      const remaining = ages.filter((entry) => entry.createdAt >= cutoff);
      let total = (await objects.list()).reduce((sum, object) => sum + object.size, 0);
      while (total > maxBytes && remaining.length > 0) {
        const oldest = remaining.shift() as { id: string };
        index.deleteCheckpoints([oldest.id]);
        report.deletedCheckpoints += 1;
        total -= await collect(report);
      }
      return report;
    },
  };

  /** Removes unreferenced objects past the grace period; returns the bytes freed. */
  async function collect(report: PurgeReport): Promise<number> {
    const referenced = index.referencedHashes();
    const graceLimit = now() - gcGraceMs;
    let freed = 0;
    for (const object of await objects.list()) {
      if (referenced.has(object.hash) || inFlight.has(object.hash) || object.mtimeMs > graceLimit) continue;
      await objects.remove(object.hash);
      report.deletedObjects += 1;
      report.freedBytes += object.size;
      freed += object.size;
    }
    return freed;
  }

  /** Records what a restore is about to overwrite in the (lazily created) safety checkpoint. */
  async function snapshotForRestore(
    checkpoint: Checkpoint,
    root: string,
    path: RelativePath,
    safety: { id: string | null },
    after: Uint8Array | null,
  ): Promise<void> {
    safety.id ??= index.createCheckpoint({
      workspaceId: checkpoint.workspaceId,
      missionId: checkpoint.missionId,
      label: `Avant la restauration : ${checkpoint.label}`,
      reason: "before_restore",
    }).id;
    const pending = await store.snapshotBeforeWrite({ checkpointId: safety.id, root, path });
    await pending.commit(after);
  }

  async function restoreOne(
    checkpoint: Checkpoint,
    file: CheckpointFile,
    root: string,
    safety: { id: string | null },
  ): Promise<RestoreFileResult> {
    const { path } = file;
    const hash = await currentHash(root, path);
    if (hash === file.beforeHash) return { status: "restored", path, checkpointId: checkpoint.id };
    if (hash !== file.afterHash) return { status: "conflict", path, currentHash: hash, expectedHash: file.afterHash };
    const before = file.beforeHash === null ? null : await objects.get(file.beforeHash);
    await snapshotForRestore(checkpoint, root, path, safety, before);
    if (before === null) {
      const target = await resolveEntry(root, path);
      await rm(target, { force: true });
    } else {
      await ensureParentDirectories(root, path);
      await atomicWrite(await resolveWriteTarget(root, path), before);
    }
    return { status: "restored", path, checkpointId: checkpoint.id };
  }

  return store;
}
