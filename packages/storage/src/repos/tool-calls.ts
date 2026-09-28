// Tool calls of missions (A1/S1): one row per call, its permission decision and its outcome.
// Arguments are stored redacted and capped by the caller (never secrets, never file contents).
import type { DatabaseSync } from "node:sqlite";
import { readJsonOrNull, readNumber, readNumberOrNull, readText, readTextOrNull, type Row } from "../sqlite";
import type { OperationClassValue } from "./missions";

export type ToolCallStateValue = "requested" | "denied" | "running" | "succeeded" | "failed" | "cancelled";
export type DecisionValue = "allow" | "ask" | "deny";

export interface ToolCallRecord {
  id: string;
  missionId: string;
  tool: string;
  operation: OperationClassValue;
  arguments: unknown;
  state: ToolCallStateValue;
  decision: DecisionValue | null;
  ruleId: string | null;
  exitCode: number | null;
  resultSummary: string | null;
  requestedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface NewToolCall {
  id: string;
  missionId: string;
  tool: string;
  operation: OperationClassValue;
  arguments: unknown;
}

export interface ToolCallRepo {
  insert(input: NewToolCall): ToolCallRecord;
  setDecision(id: string, decision: DecisionValue, ruleId: string | null): void;
  markRunning(id: string): void;
  /** Terminal state; `resultSummary` is short display text (capped at 500 characters). */
  finish(id: string, state: Exclude<ToolCallStateValue, "requested" | "running">, outcome: { exitCode: number | null; resultSummary: string | null }): void;
  get(id: string): ToolCallRecord | null;
  listByMission(missionId: string): ToolCallRecord[];
}

function toToolCall(row: Row): ToolCallRecord {
  return {
    id: readText(row, "id"),
    missionId: readText(row, "mission_id"),
    tool: readText(row, "tool"),
    operation: readText(row, "operation") as OperationClassValue,
    arguments: readJsonOrNull<unknown>(row, "arguments_json"),
    state: readText(row, "state") as ToolCallStateValue,
    decision: readTextOrNull(row, "decision") as DecisionValue | null,
    ruleId: readTextOrNull(row, "rule_id"),
    exitCode: readNumberOrNull(row, "exit_code"),
    resultSummary: readTextOrNull(row, "result_summary"),
    requestedAt: readNumber(row, "requested_at"),
    startedAt: readNumberOrNull(row, "started_at"),
    finishedAt: readNumberOrNull(row, "finished_at"),
  };
}

export function createToolCallRepo(db: DatabaseSync, now: () => number = Date.now): ToolCallRepo {
  const get = (id: string): ToolCallRecord | null => {
    const row = db.prepare("SELECT * FROM tool_calls WHERE id = ?").get(id);
    return row ? toToolCall(row) : null;
  };
  return {
    insert(input) {
      db.prepare(
        `INSERT INTO tool_calls (id, mission_id, tool, operation, arguments_json, state, requested_at)
         VALUES (?, ?, ?, ?, ?, 'requested', ?)`,
      ).run(input.id, input.missionId, input.tool, input.operation, JSON.stringify(input.arguments ?? null), now());
      const created = get(input.id);
      if (!created) throw new Error("Created tool call not found");
      return created;
    },
    setDecision(id, decision, ruleId) {
      db.prepare("UPDATE tool_calls SET decision = ?, rule_id = ? WHERE id = ?").run(decision, ruleId, id);
    },
    markRunning(id) {
      db.prepare("UPDATE tool_calls SET state = 'running', started_at = ? WHERE id = ? AND state = 'requested'").run(now(), id);
    },
    finish(id, state, outcome) {
      db.prepare(
        `UPDATE tool_calls SET state = ?, exit_code = ?, result_summary = ?, finished_at = ?
         WHERE id = ? AND state IN ('requested', 'running')`,
      ).run(state, outcome.exitCode, outcome.resultSummary?.slice(0, 500) ?? null, now(), id);
    },
    get,
    listByMission(missionId) {
      return db.prepare("SELECT * FROM tool_calls WHERE mission_id = ? ORDER BY requested_at, rowid").all(missionId).map(toToolCall);
    },
  };
}
