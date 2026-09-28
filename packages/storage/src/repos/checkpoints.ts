// Checkpoint rows (A10). Object bytes live in dataDir/checkpoints/objects/<sha256>; here only
// relative paths and hashes. Structurally implements `CheckpointIndex` of @nova/workspace.
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Checkpoint, CheckpointFile, CheckpointReason, ContentHash } from "@nova/shared";
import { readNumber, readText, readTextOrNull, withTransaction, type Row } from "../sqlite";

export interface NewCheckpoint {
  workspaceId: string;
  missionId: string | null;
  label: string;
  reason: CheckpointReason;
}

export interface CheckpointRepo {
  createCheckpoint(input: NewCheckpoint): Checkpoint;
  /** On an existing (checkpoint, path): keeps the first before_hash, updates after/user-seen. */
  upsertFile(file: CheckpointFile): void;
  get(checkpointId: string): Checkpoint | null;
  /** Newest first; missionId null = every checkpoint of the workspace. */
  list(query: { workspaceId: string; missionId: string | null; limit: number }): Checkpoint[];
  listAges(): { id: string; createdAt: number }[];
  deleteCheckpoints(ids: readonly string[]): void;
  referencedHashes(): Set<ContentHash>;
}

function toFile(row: Row): CheckpointFile {
  return {
    checkpointId: readText(row, "checkpoint_id"),
    path: readText(row, "path"),
    beforeHash: readTextOrNull(row, "before_hash"),
    afterHash: readTextOrNull(row, "after_hash"),
    userHashSeen: readTextOrNull(row, "user_hash_seen"),
  };
}

function toCheckpoint(row: Row, files: CheckpointFile[]): Checkpoint {
  return {
    id: readText(row, "id"),
    workspaceId: readText(row, "workspace_id"),
    missionId: readTextOrNull(row, "mission_id"),
    label: readText(row, "label"),
    // Guarded by a CHECK constraint.
    reason: readText(row, "reason") as CheckpointReason,
    createdAt: readNumber(row, "created_at"),
    files,
  };
}

export function createCheckpointRepo(db: DatabaseSync, now: () => number = Date.now): CheckpointRepo {
  const filesOf = (checkpointId: string): CheckpointFile[] =>
    db.prepare("SELECT * FROM checkpoint_files WHERE checkpoint_id = ? ORDER BY path").all(checkpointId).map(toFile);

  return {
    createCheckpoint({ workspaceId, missionId, label, reason }) {
      const row = db
        .prepare(
          `INSERT INTO checkpoints (id, workspace_id, mission_id, label, reason, created_at)
           VALUES (?, ?, ?, ?, ?, ?) RETURNING *`,
        )
        .get(randomUUID(), workspaceId, missionId, label, reason, now());
      if (!row) throw new Error("Checkpoint insert returned no row");
      return toCheckpoint(row, []);
    },

    upsertFile({ checkpointId, path, beforeHash, afterHash, userHashSeen }) {
      db.prepare(
        `INSERT INTO checkpoint_files (checkpoint_id, path, before_hash, after_hash, user_hash_seen)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (checkpoint_id, path) DO UPDATE SET
           after_hash = excluded.after_hash,
           user_hash_seen = coalesce(checkpoint_files.user_hash_seen, excluded.user_hash_seen)`,
      ).run(checkpointId, path, beforeHash, afterHash, userHashSeen);
    },

    get(checkpointId) {
      const row = db.prepare("SELECT * FROM checkpoints WHERE id = ?").get(checkpointId);
      return row ? toCheckpoint(row, filesOf(checkpointId)) : null;
    },

    list({ workspaceId, missionId, limit }) {
      const rows =
        missionId === null
          ? db
              .prepare("SELECT * FROM checkpoints WHERE workspace_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?")
              .all(workspaceId, limit)
          : db
              .prepare(
                `SELECT * FROM checkpoints WHERE workspace_id = ? AND mission_id = ?
                 ORDER BY created_at DESC, rowid DESC LIMIT ?`,
              )
              .all(workspaceId, missionId, limit);
      return rows.map((row) => toCheckpoint(row, filesOf(readText(row, "id"))));
    },

    listAges() {
      return db
        .prepare("SELECT id, created_at FROM checkpoints ORDER BY created_at ASC, rowid ASC")
        .all()
        .map((row) => ({ id: readText(row, "id"), createdAt: readNumber(row, "created_at") }));
    },

    deleteCheckpoints(ids) {
      if (ids.length === 0) return;
      const remove = db.prepare("DELETE FROM checkpoints WHERE id = ?");
      // checkpoint_files rows go with ON DELETE CASCADE.
      withTransaction(db, () => {
        for (const id of ids) remove.run(id);
      });
    },

    referencedHashes() {
      const hashes = new Set<ContentHash>();
      const rows = db
        .prepare(
          `SELECT before_hash AS hash FROM checkpoint_files WHERE before_hash IS NOT NULL
           UNION SELECT after_hash FROM checkpoint_files WHERE after_hash IS NOT NULL
           UNION SELECT user_hash_seen FROM checkpoint_files WHERE user_hash_seen IS NOT NULL`,
        )
        .all();
      for (const row of rows) hashes.add(readText(row, "hash"));
      return hashes;
    },
  };
}
