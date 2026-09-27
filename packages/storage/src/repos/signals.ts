// Companion signals (N2): recorded facts that may justify a suggestion from Nomi.
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { readJsonOrNull, readNumber, readText, readTextOrNull, type Row } from "../sqlite";

/** Mirrors the companion signal kind union of @nova/shared. */
export type SignalKindValue =
  | "test_failed"
  | "process_crashed"
  | "mission_waiting"
  | "mission_done"
  | "mission_failed"
  | "budget_reached"
  | "approval_pending";
/** Mirrors the signal state union of @nova/shared. */
export type SignalStateValue = "new" | "seen" | "ignored";

export interface SignalRecord {
  id: string;
  workspaceId: string | null;
  missionId: string | null;
  kind: SignalKindValue;
  /** What produced the fact (tool call id, process id, test run…). */
  sourceRef: string;
  /** Evidence shown with the suggestion (output excerpt, path); secrets redacted upstream. */
  evidence: unknown;
  state: SignalStateValue;
  createdAt: number;
}

export interface NewSignal {
  workspaceId: string | null;
  missionId: string | null;
  kind: SignalKindValue;
  sourceRef: string;
  evidence: unknown;
}

export interface SignalRepo {
  /** Inserts a signal in state `new`. */
  insert(input: NewSignal): SignalRecord;
  /** Signals in state `new`, oldest first. */
  listNew(): SignalRecord[];
}

function toSignal(row: Row): SignalRecord {
  return {
    id: readText(row, "id"),
    workspaceId: readTextOrNull(row, "workspace_id"),
    missionId: readTextOrNull(row, "mission_id"),
    // Enum columns are guarded by CHECK constraints.
    kind: readText(row, "kind") as SignalKindValue,
    sourceRef: readText(row, "source_ref"),
    evidence: readJsonOrNull<unknown>(row, "evidence_json"),
    state: readText(row, "state") as SignalStateValue,
    createdAt: readNumber(row, "created_at"),
  };
}

export function createSignalRepo(db: DatabaseSync, now: () => number = Date.now): SignalRepo {
  return {
    insert(input) {
      const row = db
        .prepare(
          `INSERT INTO signals (id, workspace_id, mission_id, kind, source_ref, evidence_json, state, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'new', ?) RETURNING *`,
        )
        .get(
          randomUUID(),
          input.workspaceId,
          input.missionId,
          input.kind,
          input.sourceRef,
          JSON.stringify(input.evidence ?? null),
          now(),
        );
      if (!row) throw new Error("Signal insert returned no row");
      return toSignal(row);
    },

    listNew() {
      return db
        .prepare("SELECT * FROM signals WHERE state = 'new' ORDER BY created_at, rowid")
        .all()
        .map(toSignal);
    },
  };
}
