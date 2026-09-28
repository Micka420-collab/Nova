// Proofs (A4): what NOVA actually ran and observed. Outputs live in artifacts (output_ref).
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { readNumber, readNumberOrNull, readText, readTextOrNull, type Row } from "../sqlite";

export type ProofKindValue = "command" | "test" | "screenshot" | "diff";

export interface ProofRecord {
  id: string;
  missionId: string;
  taskId: string | null;
  toolCallId: string | null;
  kind: ProofKindValue;
  /** argv of the command that produced the proof. */
  command: string[] | null;
  exitCode: number | null;
  summary: string;
  outputRef: string | null;
  createdAt: number;
}

export type NewProof = Omit<ProofRecord, "id" | "createdAt">;

export interface ProofRepo {
  insert(input: NewProof): ProofRecord;
  listByMission(missionId: string): ProofRecord[];
}

function toProof(row: Row): ProofRecord {
  const command = readTextOrNull(row, "command");
  return {
    id: readText(row, "id"),
    missionId: readText(row, "mission_id"),
    taskId: readTextOrNull(row, "task_id"),
    toolCallId: readTextOrNull(row, "tool_call_id"),
    kind: readText(row, "kind") as ProofKindValue,
    command: command === null ? null : (JSON.parse(command) as string[]),
    exitCode: readNumberOrNull(row, "exit_code"),
    summary: readText(row, "summary"),
    outputRef: readTextOrNull(row, "output_ref"),
    createdAt: readNumber(row, "created_at"),
  };
}

export function createProofRepo(db: DatabaseSync, now: () => number = Date.now): ProofRepo {
  return {
    insert(input) {
      const row = db
        .prepare(
          `INSERT INTO proofs (id, mission_id, task_id, tool_call_id, kind, command, exit_code, summary, output_ref, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
        )
        .get(
          randomUUID(),
          input.missionId,
          input.taskId,
          input.toolCallId,
          input.kind,
          input.command === null ? null : JSON.stringify(input.command),
          input.exitCode,
          input.summary.slice(0, 2_000),
          input.outputRef,
          now(),
        );
      if (!row) throw new Error("Proof insert returned no row");
      return toProof(row);
    },
    listByMission(missionId) {
      return db.prepare("SELECT * FROM proofs WHERE mission_id = ? ORDER BY created_at, rowid").all(missionId).map(toProof);
    },
  };
}
