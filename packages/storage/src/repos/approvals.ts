// Approval requests shown on the approval card (S1).
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { readJsonOrNull, readNumber, readNumberOrNull, readText, readTextOrNull, type Row } from "../sqlite";

/** Mirrors the approval status union of @nova/shared. */
export type ApprovalStatusValue = "pending" | "approved" | "denied" | "expired";
/** Mirrors the approval scope union of @nova/shared. */
export type ApprovalScopeValue = "once" | "mission" | "project";

export interface ApprovalRecord {
  id: string;
  workspaceId: string;
  missionId: string | null;
  toolCallId: string | null;
  /** What is asked (tool, operation, target, arguments summary); never secrets. */
  request: unknown;
  status: ApprovalStatusValue;
  scope: ApprovalScopeValue | null;
  ruleId: string | null;
  createdAt: number;
  decidedAt: number | null;
  expiresAt: number | null;
}

export interface NewApproval {
  workspaceId: string;
  missionId: string | null;
  toolCallId: string | null;
  request: unknown;
  /** Rule that asked (explainability). */
  ruleId: string | null;
  expiresAt: number | null;
}

export interface ApprovalFilter {
  workspaceId?: string | null;
  missionId?: string | null;
  status?: ApprovalStatusValue | null;
  /** Default 200, max 1 000. */
  limit?: number;
}

export interface ApprovalRepo {
  /** Inserts a `pending` approval request. */
  insert(input: NewApproval): ApprovalRecord;
  get(id: string): ApprovalRecord | null;
  /** Pending requests of a workspace, oldest first. */
  listPending(workspaceId: string): ApprovalRecord[];
  /** Filtered list (null/absent filters match anything), oldest first. */
  list(filter: ApprovalFilter): ApprovalRecord[];
  /**
   * Resolves a PENDING request (approved with a scope, or denied). Returns the updated record, or
   * null when it is not pending anymore (already decided or expired): decisions are final.
   */
  decide(id: string, decision: { status: "approved"; scope: ApprovalScopeValue } | { status: "denied" }): ApprovalRecord | null;
  /** Marks a mission's pending requests `expired` (mission stopped); returns them. */
  expireForMission(missionId: string): ApprovalRecord[];
  /** Marks every pending request `expired` (startup: nobody awaits them anymore); returns them. */
  expireAllPending(): ApprovalRecord[];
}

const LIST_DEFAULT = 200;
const LIST_MAX = 1_000;

function toApproval(row: Row): ApprovalRecord {
  return {
    id: readText(row, "id"),
    workspaceId: readText(row, "workspace_id"),
    missionId: readTextOrNull(row, "mission_id"),
    toolCallId: readTextOrNull(row, "tool_call_id"),
    request: readJsonOrNull<unknown>(row, "request_json"),
    // Enum columns are guarded by CHECK constraints.
    status: readText(row, "status") as ApprovalStatusValue,
    scope: readTextOrNull(row, "scope") as ApprovalScopeValue | null,
    ruleId: readTextOrNull(row, "rule_id"),
    createdAt: readNumber(row, "created_at"),
    decidedAt: readNumberOrNull(row, "decided_at"),
    expiresAt: readNumberOrNull(row, "expires_at"),
  };
}

export function createApprovalRepo(db: DatabaseSync, now: () => number = Date.now): ApprovalRepo {
  return {
    insert(input) {
      const row = db
        .prepare(
          `INSERT INTO approvals
             (id, workspace_id, mission_id, tool_call_id, request_json, status, rule_id, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?) RETURNING *`,
        )
        .get(
          randomUUID(),
          input.workspaceId,
          input.missionId,
          input.toolCallId,
          JSON.stringify(input.request ?? null),
          input.ruleId,
          now(),
          input.expiresAt,
        );
      if (!row) throw new Error("Approval insert returned no row");
      return toApproval(row);
    },

    get(id) {
      const row = db.prepare("SELECT * FROM approvals WHERE id = ?").get(id);
      return row ? toApproval(row) : null;
    },

    list(filter) {
      const limit = Math.min(Math.max(1, Math.trunc(filter.limit ?? LIST_DEFAULT)), LIST_MAX);
      return db
        .prepare(
          `SELECT * FROM approvals
           WHERE (?1 IS NULL OR workspace_id = ?1)
             AND (?2 IS NULL OR mission_id = ?2)
             AND (?3 IS NULL OR status = ?3)
           ORDER BY created_at, rowid LIMIT ?4`,
        )
        .all(filter.workspaceId ?? null, filter.missionId ?? null, filter.status ?? null, limit)
        .map(toApproval);
    },

    decide(id, decision) {
      const scope = decision.status === "approved" ? decision.scope : null;
      const row = db
        .prepare(
          `UPDATE approvals SET status = ?, scope = ?, decided_at = ?
           WHERE id = ? AND status = 'pending' RETURNING *`,
        )
        .get(decision.status, scope, now(), id);
      return row ? toApproval(row) : null;
    },

    expireForMission(missionId) {
      return db
        .prepare(
          `UPDATE approvals SET status = 'expired', decided_at = ?
           WHERE mission_id = ? AND status = 'pending' RETURNING *`,
        )
        .all(now(), missionId)
        .map(toApproval);
    },

    expireAllPending() {
      return db
        .prepare("UPDATE approvals SET status = 'expired', decided_at = ? WHERE status = 'pending' RETURNING *")
        .all(now())
        .map(toApproval);
    },

    listPending(workspaceId) {
      return db
        .prepare(
          `SELECT * FROM approvals WHERE workspace_id = ? AND status = 'pending'
           ORDER BY created_at, rowid`,
        )
        .all(workspaceId)
        .map(toApproval);
    },
  };
}
