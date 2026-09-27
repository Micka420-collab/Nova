// Companion suggestions (N2): every row references the signal that justifies it (`signal_id`,
// NOT NULL, cascade) — no suggestion without a signal. The user's answer is recorded with its time.
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { jsonOrNull, readJsonOrNull, readNumber, readNumberOrNull, readText, type Row } from "../sqlite";

/** Mirrors the suggestion status union of @nova/shared. */
export type SuggestionStatusValue = "proposed" | "accepted" | "dismissed" | "snoozed";

export interface SuggestionRecord {
  id: string;
  signalId: string;
  text: string;
  /** The CompanionAction as written by main (typed by the caller). */
  action: unknown;
  status: SuggestionStatusValue;
  createdAt: number;
  decidedAt: number | null;
}

export interface NewSuggestion {
  signalId: string;
  text: string;
  action: unknown;
}

export interface SuggestionRepo {
  /** Inserts in `proposed`; throws when the signal does not exist (foreign key). */
  insert(input: NewSuggestion): SuggestionRecord;
  get(id: string): SuggestionRecord | null;
  /** Proposed suggestions, newest first. */
  listProposed(): SuggestionRecord[];
  /** Latest suggestion of a signal, any status. */
  latestForSignal(signalId: string): SuggestionRecord | null;
  /** Creation time of the most recent suggestion (rate limit), null when none. */
  lastCreatedAt(): number | null;
  /** Records the answer; returns null when the suggestion does not exist. */
  decide(id: string, status: Exclude<SuggestionStatusValue, "proposed">): SuggestionRecord | null;
}

function toSuggestion(row: Row): SuggestionRecord {
  return {
    id: readText(row, "id"),
    signalId: readText(row, "signal_id"),
    text: readText(row, "text"),
    action: readJsonOrNull<unknown>(row, "action_json"),
    // Enum column guarded by a CHECK constraint.
    status: readText(row, "status") as SuggestionStatusValue,
    createdAt: readNumber(row, "created_at"),
    decidedAt: readNumberOrNull(row, "decided_at"),
  };
}

export function createSuggestionRepo(db: DatabaseSync, now: () => number = Date.now): SuggestionRepo {
  return {
    insert(input) {
      const row = db
        .prepare(
          `INSERT INTO suggestions (id, signal_id, text, action_json, status, created_at, decided_at)
           VALUES (?, ?, ?, ?, 'proposed', ?, NULL) RETURNING *`,
        )
        .get(randomUUID(), input.signalId, input.text, jsonOrNull(input.action), now());
      if (!row) throw new Error("Suggestion insert returned no row");
      return toSuggestion(row);
    },

    get(id) {
      const row = db.prepare("SELECT * FROM suggestions WHERE id = ?").get(id);
      return row ? toSuggestion(row) : null;
    },

    listProposed() {
      return db
        .prepare("SELECT * FROM suggestions WHERE status = 'proposed' ORDER BY created_at DESC, rowid DESC")
        .all()
        .map(toSuggestion);
    },

    latestForSignal(signalId) {
      const row = db
        .prepare("SELECT * FROM suggestions WHERE signal_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1")
        .get(signalId);
      return row ? toSuggestion(row) : null;
    },

    lastCreatedAt() {
      const row = db.prepare("SELECT max(created_at) AS at FROM suggestions").get();
      return row ? readNumberOrNull(row, "at") : null;
    },

    decide(id, status) {
      const row = db
        .prepare("UPDATE suggestions SET status = ?, decided_at = ? WHERE id = ? RETURNING *")
        .get(status, now(), id);
      return row ? toSuggestion(row) : null;
    },
  };
}
