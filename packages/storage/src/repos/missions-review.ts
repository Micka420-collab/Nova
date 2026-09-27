// Review decisions (A11): keep/revert per file (hunk_index NULL) or per hunk; last decision wins.
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { readNumber, readNumberOrNull, readText, withTransaction, type Row } from "../sqlite";

export interface ReviewDecisionRecord {
  missionId: string;
  path: string;
  hunkIndex: number | null;
  decision: "kept" | "reverted";
  decidedAt: number;
}

export interface ReviewRepo {
  record(missionId: string, decisions: { path: string; hunkIndex: number | null; decision: "kept" | "reverted" }[]): void;
  list(missionId: string): ReviewDecisionRecord[];
}

function toDecision(row: Row): ReviewDecisionRecord {
  return {
    missionId: readText(row, "mission_id"),
    path: readText(row, "path"),
    hunkIndex: readNumberOrNull(row, "hunk_index"),
    decision: readText(row, "decision") as "kept" | "reverted",
    decidedAt: readNumber(row, "decided_at"),
  };
}

export function createReviewRepo(db: DatabaseSync, now: () => number = Date.now): ReviewRepo {
  return {
    record(missionId, decisions) {
      const time = now();
      withTransaction(db, () => {
        const remove = db.prepare(
          "DELETE FROM review_decisions WHERE mission_id = ? AND path = ? AND coalesce(hunk_index, -1) = coalesce(?, -1)",
        );
        const insert = db.prepare(
          "INSERT INTO review_decisions (id, mission_id, path, hunk_index, decision, decided_at) VALUES (?, ?, ?, ?, ?, ?)",
        );
        for (const decision of decisions) {
          remove.run(missionId, decision.path, decision.hunkIndex);
          insert.run(randomUUID(), missionId, decision.path, decision.hunkIndex, decision.decision, time);
        }
      });
    },
    list(missionId) {
      return db
        .prepare("SELECT * FROM review_decisions WHERE mission_id = ? ORDER BY path, coalesce(hunk_index, -1)")
        .all(missionId)
        .map(toDecision);
    },
  };
}
