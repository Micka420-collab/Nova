// Timeline search (J2-B L8) over stored mission events (FTS5 table kept in sync by triggers).
// The indexed body is the stored payload JSON; the service turns a hit into a redacted,
// human-readable excerpt (never the raw JSON, never an FTS snippet cut through a secret).
import type { DatabaseSync } from "node:sqlite";
import type { MissionEventType } from "@nova/shared";
import { readNumber, readText, type Row } from "../sqlite";

export interface TimelineSearchRecord {
  missionId: string;
  missionTitle: string;
  seq: number;
  type: MissionEventType;
  at: number;
  /** Raw FTS snippet of the stored payload (unredacted: for diagnostics only, never displayed). */
  snippet: string;
  /** Stored payload JSON of the event (unredacted): the service builds the displayed excerpt from it. */
  payload: string;
}

export interface TimelineSearchRepo {
  /**
   * Every term must match (prefix match on the last one), accents ignored. User text is never
   * passed as FTS syntax. Newest first. A query without any word character = no result.
   */
  search(input: { query: string; workspaceId: string | null; missionId: string | null; limit: number }): TimelineSearchRecord[];
}

/** At most this many terms reach FTS (a pasted paragraph is not a query). */
export const TIMELINE_QUERY_MAX_TERMS = 16;

/**
 * Terms of a user query, split like the `unicode61` tokenizer splits the indexed text (letters,
 * digits, marks and private-use characters form words; everything else separates them), so that
 * punctuation never becomes an empty phrase that matches nothing.
 */
export function queryTerms(query: string): string[] {
  return query
    .normalize("NFC")
    .split(/[^\p{L}\p{N}\p{M}\p{Co}]+/u)
    .filter((term) => term.length > 0)
    .slice(0, TIMELINE_QUERY_MAX_TERMS);
}

/** Quotes each term as an FTS5 string (operators and column filters in user text are inert). */
export function toFtsQuery(query: string): string | null {
  const terms = queryTerms(query);
  if (terms.length === 0) return null;
  return terms.map((term, index) => `"${term}"${index === terms.length - 1 ? "*" : ""}`).join(" ");
}

function toRecord(row: Row): TimelineSearchRecord {
  return {
    missionId: readText(row, "mission_id"),
    missionTitle: readText(row, "title"),
    seq: readNumber(row, "seq"),
    // Stored types are written by the journal from the MissionEvent union.
    type: readText(row, "type") as MissionEventType,
    at: readNumber(row, "created_at"),
    snippet: readText(row, "snippet"),
    payload: readText(row, "payload_json"),
  };
}

export function createTimelineSearchRepo(db: DatabaseSync): TimelineSearchRepo {
  const statement = db.prepare(
    `SELECT e.mission_id, m.title, e.seq, e.type, e.created_at, e.payload_json,
            snippet(mission_events_fts, 0, '', '', '…', 24) AS snippet
       FROM mission_events_fts
       JOIN mission_events e ON e.seq = mission_events_fts.rowid
       JOIN missions m ON m.id = e.mission_id
      WHERE mission_events_fts MATCH ?
        AND (? IS NULL OR m.workspace_id = ?)
        AND (? IS NULL OR e.mission_id = ?)
      ORDER BY e.seq DESC
      LIMIT ?`,
  );
  return {
    search({ query, workspaceId, missionId, limit }) {
      const match = toFtsQuery(query);
      if (match === null) return [];
      return statement.all(match, workspaceId, workspaceId, missionId, missionId, Math.max(0, Math.floor(limit))).map(toRecord);
    },
  };
}
