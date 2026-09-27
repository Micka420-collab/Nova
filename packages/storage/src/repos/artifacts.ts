// Produced artifacts (F7): reports, screenshots, exports, command logs. The bytes live in dataDir,
// addressed by content_hash; this table only indexes them.
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { readNumber, readText, readTextOrNull, type Row } from "../sqlite";

export type ArtifactKindValue = "report" | "screenshot" | "export" | "log";

export interface ArtifactRecord {
  id: string;
  workspaceId: string | null;
  missionId: string | null;
  kind: ArtifactKindValue;
  title: string;
  contentHash: string;
  sizeBytes: number;
  mime: string;
  createdAt: number;
}

export type NewArtifact = Omit<ArtifactRecord, "id" | "createdAt">;

export interface ArtifactRepo {
  create(input: NewArtifact): ArtifactRecord;
  get(id: string): ArtifactRecord | null;
  /** Newest first. */
  listByMission(missionId: string, limit?: number): ArtifactRecord[];
  listByWorkspace(workspaceId: string, limit?: number): ArtifactRecord[];
  /** Content hashes still referenced (object store garbage collection). */
  referencedHashes(): Set<string>;
  delete(id: string): boolean;
}

const DEFAULT_LIMIT = 100;

function toArtifact(row: Row): ArtifactRecord {
  return {
    id: readText(row, "id"),
    workspaceId: readTextOrNull(row, "workspace_id"),
    missionId: readTextOrNull(row, "mission_id"),
    // Guarded by a CHECK constraint.
    kind: readText(row, "kind") as ArtifactKindValue,
    title: readText(row, "title"),
    contentHash: readText(row, "content_hash"),
    sizeBytes: readNumber(row, "size_bytes"),
    mime: readText(row, "mime"),
    createdAt: readNumber(row, "created_at"),
  };
}

export function createArtifactRepo(db: DatabaseSync, now: () => number = Date.now): ArtifactRepo {
  return {
    create(input) {
      const row = db
        .prepare(
          `INSERT INTO artifacts (id, workspace_id, mission_id, kind, title, content_hash, size_bytes, mime, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
        )
        .get(
          randomUUID(),
          input.workspaceId,
          input.missionId,
          input.kind,
          input.title,
          input.contentHash,
          input.sizeBytes,
          input.mime,
          now(),
        );
      if (!row) throw new Error("Artifact insert returned no row");
      return toArtifact(row);
    },

    get(id) {
      const row = db.prepare("SELECT * FROM artifacts WHERE id = ?").get(id);
      return row ? toArtifact(row) : null;
    },

    listByMission(missionId, limit = DEFAULT_LIMIT) {
      return db
        .prepare("SELECT * FROM artifacts WHERE mission_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?")
        .all(missionId, limit)
        .map(toArtifact);
    },

    listByWorkspace(workspaceId, limit = DEFAULT_LIMIT) {
      return db
        .prepare("SELECT * FROM artifacts WHERE workspace_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?")
        .all(workspaceId, limit)
        .map(toArtifact);
    },

    referencedHashes() {
      const hashes = new Set<string>();
      for (const row of db.prepare("SELECT DISTINCT content_hash FROM artifacts").all()) {
        hashes.add(readText(row, "content_hash"));
      }
      return hashes;
    },

    delete(id) {
      return db.prepare("DELETE FROM artifacts WHERE id = ?").run(id).changes > 0;
    },
  };
}
