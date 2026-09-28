// Permission rules (`policies`, S1): remembered approvals, contract rules, custom-profile rules,
// plus the workspace permission profile (`workspaces.permission_profile`), which this repo owns.
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { PermissionProfile, PermissionRule } from "@nova/shared";
import { readNumber, readNumberOrNull, readText, readTextOrNull, type Row } from "../sqlite";

export type NewPolicy = Omit<PermissionRule, "id" | "createdAt">;

export interface PolicyRepo {
  insert(input: NewPolicy): PermissionRule;
  /**
   * Rules the engine needs for a call: global, the workspace's, and the mission's (when given),
   * not expired at `at`. Any order (the engine ranks them).
   */
  listForEvaluation(workspaceId: string, missionId: string | null, at?: number): PermissionRule[];
  /** Rules of a workspace (Réglages › Permissions), newest first; mission rules excluded. */
  listForWorkspace(workspaceId: string): PermissionRule[];
  /** Revokes one rule; false when it did not exist. */
  delete(id: string): boolean;
  /** "Tout révoquer": removes the user's remembered rules of a workspace; returns the count. */
  revokeUserRules(workspaceId: string): number;
  /** Removes a mission's rules when it ends (they would never match again). */
  deleteForMission(missionId: string): number;
  /** Workspace permission profile; null when the workspace does not exist. */
  getProfile(workspaceId: string): PermissionProfile | null;
  /** Returns false when the workspace does not exist. */
  setProfile(workspaceId: string, profile: PermissionProfile): boolean;
}

function toRule(row: Row): PermissionRule {
  return {
    id: readText(row, "id"),
    workspaceId: readTextOrNull(row, "workspace_id"),
    missionId: readTextOrNull(row, "mission_id"),
    // Tool names are validated by the writer (main); enum columns are guarded by CHECK constraints.
    tool: readTextOrNull(row, "tool") as PermissionRule["tool"],
    operation: readTextOrNull(row, "operation") as PermissionRule["operation"],
    pathGlob: readTextOrNull(row, "path_glob"),
    host: readTextOrNull(row, "host"),
    decision: readText(row, "decision") as PermissionRule["decision"],
    scope: readText(row, "scope") as PermissionRule["scope"],
    source: readText(row, "source") as PermissionRule["source"],
    createdAt: readNumber(row, "created_at"),
    expiresAt: readNumberOrNull(row, "expires_at"),
  };
}

export function createPolicyRepo(db: DatabaseSync, now: () => number = Date.now): PolicyRepo {
  return {
    insert(input) {
      if (input.scope === "mission" && input.missionId === null) {
        throw new Error("A mission-scoped rule needs a mission id");
      }
      const row = db
        .prepare(
          `INSERT INTO policies
             (id, workspace_id, mission_id, tool, operation, path_glob, host, decision, scope, source, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
        )
        .get(
          randomUUID(),
          input.workspaceId,
          input.missionId,
          input.tool,
          input.operation,
          input.pathGlob,
          input.host,
          input.decision,
          input.scope,
          input.source,
          now(),
          input.expiresAt,
        );
      if (!row) throw new Error("Policy insert returned no row");
      return toRule(row);
    },

    listForEvaluation(workspaceId, missionId, at = now()) {
      return db
        .prepare(
          `SELECT * FROM policies
           WHERE (workspace_id IS NULL OR workspace_id = ?)
             AND (mission_id IS NULL OR mission_id = ?)
             AND (expires_at IS NULL OR expires_at > ?)
           ORDER BY created_at, rowid`,
        )
        .all(workspaceId, missionId, at)
        .map(toRule);
    },

    listForWorkspace(workspaceId) {
      return db
        .prepare(
          `SELECT * FROM policies WHERE workspace_id = ? AND mission_id IS NULL
           ORDER BY created_at DESC, rowid DESC`,
        )
        .all(workspaceId)
        .map(toRule);
    },

    delete(id) {
      return Number(db.prepare("DELETE FROM policies WHERE id = ?").run(id).changes) > 0;
    },

    revokeUserRules(workspaceId) {
      return Number(db.prepare("DELETE FROM policies WHERE workspace_id = ? AND source = 'user'").run(workspaceId).changes);
    },

    deleteForMission(missionId) {
      return Number(db.prepare("DELETE FROM policies WHERE mission_id = ?").run(missionId).changes);
    },

    getProfile(workspaceId) {
      const row = db.prepare("SELECT permission_profile FROM workspaces WHERE id = ?").get(workspaceId);
      // Guarded by a CHECK constraint.
      return row ? (readText(row, "permission_profile") as PermissionProfile) : null;
    },

    setProfile(workspaceId, profile) {
      return Number(db.prepare("UPDATE workspaces SET permission_profile = ? WHERE id = ?").run(profile, workspaceId).changes) > 0;
    },
  };
}
