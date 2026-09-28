// Mission links (J2-B L5 sub-missions, L8 forks): where a child mission comes from.
import type { DatabaseSync } from "node:sqlite";
import type { MissionLink, MissionLinkKind, SubMissionIntegration } from "@nova/shared";
import { readNumber, readNumberOrNull, readText, readTextOrNull, type Row } from "../sqlite";

export type NewMissionLink = Omit<MissionLink, "createdAt" | "updatedAt">;

export interface MissionLinkRepo {
  /** Throws on a second link for the same child (a mission has one origin). */
  insert(input: NewMissionLink): MissionLink;
  /** The link of a child mission, or null for a top-level mission. */
  get(childMissionId: string): MissionLink | null;
  /** Children of a parent, oldest first; `kind` null = both kinds. */
  listChildren(parentMissionId: string, kind?: MissionLinkKind | null): MissionLink[];
  /**
   * Sub-mission links with something left to do: child running (integration null), integration
   * pending/in progress/refused, or a worktree still on disk. Oldest first.
   */
  listUnsettled(): MissionLink[];
  setIntegration(childMissionId: string, integration: SubMissionIntegration): MissionLink | null;
  setWorktree(childMissionId: string, worktree: string | null): MissionLink | null;
}

function toLink(row: Row): MissionLink {
  return {
    childMissionId: readText(row, "child_mission_id"),
    parentMissionId: readText(row, "parent_mission_id"),
    // Enum columns are guarded by CHECK constraints.
    kind: readText(row, "kind") as MissionLinkKind,
    forkSeq: readNumberOrNull(row, "fork_seq"),
    depth: readNumber(row, "depth"),
    reservedUsd: readNumberOrNull(row, "reserved_usd"),
    worktree: readTextOrNull(row, "worktree"),
    integration: readTextOrNull(row, "integration") as SubMissionIntegration | null,
    createdAt: readNumber(row, "created_at"),
    updatedAt: readNumber(row, "updated_at"),
  };
}

export function createMissionLinkRepo(db: DatabaseSync, now: () => number = Date.now): MissionLinkRepo {
  const get = (childMissionId: string): MissionLink | null => {
    const row = db.prepare("SELECT * FROM mission_links WHERE child_mission_id = ?").get(childMissionId);
    return row ? toLink(row) : null;
  };

  return {
    insert(input) {
      const time = now();
      db.prepare(
        `INSERT INTO mission_links (child_mission_id, parent_mission_id, kind, fork_seq, depth, reserved_usd, worktree,
           integration, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.childMissionId,
        input.parentMissionId,
        input.kind,
        input.forkSeq,
        input.depth,
        input.reservedUsd,
        input.worktree,
        input.integration,
        time,
        time,
      );
      const created = get(input.childMissionId);
      if (!created) throw new Error("Inserted mission link not found");
      return created;
    },

    get,

    listChildren(parentMissionId, kind = null) {
      const rows =
        kind === null
          ? db.prepare("SELECT * FROM mission_links WHERE parent_mission_id = ? ORDER BY created_at, rowid").all(parentMissionId)
          : db
              .prepare("SELECT * FROM mission_links WHERE parent_mission_id = ? AND kind = ? ORDER BY created_at, rowid")
              .all(parentMissionId, kind);
      return rows.map(toLink);
    },

    listUnsettled() {
      return db
        .prepare(
          `SELECT * FROM mission_links
           WHERE kind = 'submission'
             AND (integration IS NULL OR integration IN ('pending', 'testing', 'tests_failed', 'conflict') OR worktree IS NOT NULL)
           ORDER BY created_at, rowid`,
        )
        .all()
        .map(toLink);
    },

    setIntegration(childMissionId, integration) {
      db.prepare("UPDATE mission_links SET integration = ?, updated_at = ? WHERE child_mission_id = ?").run(integration, now(), childMissionId);
      return get(childMissionId);
    },

    setWorktree(childMissionId, worktree) {
      db.prepare("UPDATE mission_links SET worktree = ?, updated_at = ? WHERE child_mission_id = ?").run(worktree, now(), childMissionId);
      return get(childMissionId);
    },
  };
}
