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

export interface ApprovalRepo {
  /** Inserts a `pending` approval request. */
  insert(input: NewApproval): ApprovalRecord;
  /** Pending requests of a workspace, oldest first. */
  listPending(workspaceId: string): ApprovalRecord[];
}

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
