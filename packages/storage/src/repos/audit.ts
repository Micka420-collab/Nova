// Audit trail (`audit_log`, S5). Append-only: this repo exposes no update and no per-row delete;
// the only removal is the retention purge (rows older than the cutoff). Never store content:
// `target` is a relative path or a host, `dataSummary` holds sizes and types only.
import type { DatabaseSync } from "node:sqlite";
import { jsonOrNull, readJsonOrNull, readNumber, readNumberOrNull, readText, readTextOrNull, type Row } from "../sqlite";

export type AuditActorValue = "user" | "agent" | "system";
export type AuditDecisionValue = "allow" | "ask" | "deny";

/** Sizes and kinds of data that left NOVA or were touched; never the data itself. */
export interface AuditDataSummary {
  [key: string]: string | number | boolean | null;
}

export interface AuditRecord {
  seq: number;
  createdAt: number;
  workspaceId: string | null;
  missionId: string | null;
  toolCallId: string | null;
  actor: AuditActorValue;
  /** Dotted action name: `permission.decision`, `tool.executed`, `approval.decided`… */
  action: string;
  decision: AuditDecisionValue | null;
  ruleId: string | null;
  /** Relative path, host or tool name. */
  target: string | null;
  dataSummary: AuditDataSummary | null;
  /** USD; null = none or unknown. */
  cost: number | null;
  /** Short outcome code or explanation (already redacted by the caller). */
  outcome: string | null;
}

export type NewAuditEntry = Omit<AuditRecord, "seq" | "createdAt">;

export interface AuditFilter {
  workspaceId?: string | null;
  missionId?: string | null;
  actor?: AuditActorValue | null;
  /** Exact action, or a prefix ending with "." (`tool.`). */
  action?: string | null;
  decision?: AuditDecisionValue | null;
  /** Inclusive lower bound on createdAt. */
  since?: number | null;
  /** Exclusive upper bound on createdAt. */
  until?: number | null;
  /**
   * `dataSummary.operation` (read, write, network…): "tout ce qui est parti sur Internet cette
   * semaine" = { operation: "network", since }.
   */
  operation?: string | null;
  /** Page backwards: only rows with seq < beforeSeq. */
  beforeSeq?: number | null;
  /** Default 200, max 1 000. */
  limit?: number;
}

export interface AuditRepo {
  append(entry: NewAuditEntry): AuditRecord;
  /** Newest first. */
  list(filter: AuditFilter): AuditRecord[];
  /** Deletes rows created before `cutoff`; returns the count (secure_delete zeroes them). */
  purgeBefore(cutoff: number): number;
}

const LIST_DEFAULT = 200;
const LIST_MAX = 1_000;

function toAudit(row: Row): AuditRecord {
  return {
    seq: readNumber(row, "seq"),
    createdAt: readNumber(row, "created_at"),
    workspaceId: readTextOrNull(row, "workspace_id"),
    missionId: readTextOrNull(row, "mission_id"),
    toolCallId: readTextOrNull(row, "tool_call_id"),
    // Enum columns are guarded by CHECK constraints.
    actor: readText(row, "actor") as AuditActorValue,
    action: readText(row, "action"),
    decision: readTextOrNull(row, "decision") as AuditDecisionValue | null,
    ruleId: readTextOrNull(row, "rule_id"),
    target: readTextOrNull(row, "target"),
    dataSummary: readJsonOrNull<AuditDataSummary>(row, "data_summary_json"),
    cost: readNumberOrNull(row, "cost"),
    outcome: readTextOrNull(row, "outcome"),
  };
}

export function createAuditRepo(db: DatabaseSync, now: () => number = Date.now): AuditRepo {
  return {
    append(entry) {
      const row = db
        .prepare(
          `INSERT INTO audit_log
             (created_at, workspace_id, mission_id, tool_call_id, actor, action, decision, rule_id, target,
              data_summary_json, cost, outcome)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
        )
        .get(
          now(),
          entry.workspaceId,
          entry.missionId,
          entry.toolCallId,
          entry.actor,
          entry.action,
          entry.decision,
          entry.ruleId,
          entry.target,
          jsonOrNull(entry.dataSummary),
          entry.cost,
          entry.outcome,
        );
      if (!row) throw new Error("Audit insert returned no row");
      return toAudit(row);
    },

    list(filter) {
      const limit = Math.min(Math.max(1, Math.trunc(filter.limit ?? LIST_DEFAULT)), LIST_MAX);
      const action = filter.action ?? null;
      const prefix = action !== null && action.endsWith(".");
      return db
        .prepare(
          `SELECT * FROM audit_log
           WHERE (?1 IS NULL OR workspace_id = ?1)
             AND (?2 IS NULL OR mission_id = ?2)
             AND (?3 IS NULL OR actor = ?3)
             AND (?4 IS NULL OR (?5 = 1 AND substr(action, 1, length(?4)) = ?4) OR (?5 = 0 AND action = ?4))
             AND (?6 IS NULL OR decision = ?6)
             AND (?7 IS NULL OR created_at >= ?7)
             AND (?8 IS NULL OR created_at < ?8)
             AND (?9 IS NULL OR seq < ?9)
             AND (?11 IS NULL OR json_extract(data_summary_json, '$.operation') = ?11)
           ORDER BY seq DESC LIMIT ?10`,
        )
        .all(
          filter.workspaceId ?? null,
          filter.missionId ?? null,
          filter.actor ?? null,
          action,
          prefix ? 1 : 0,
          filter.decision ?? null,
          filter.since ?? null,
          filter.until ?? null,
          filter.beforeSeq ?? null,
          limit,
          filter.operation ?? null,
        )
        .map(toAudit);
    },

    purgeBefore(cutoff) {
      return Number(db.prepare("DELETE FROM audit_log WHERE created_at < ?").run(cutoff).changes);
    },
  };
}
