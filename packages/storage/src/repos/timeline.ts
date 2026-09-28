// Timeline search (J2-B L8) over stored mission events (FTS5 table kept in sync by triggers).
import type { DatabaseSync } from "node:sqlite";
import type { MissionEventType } from "@nova/shared";
import { readNumber, readText, type Row } from "../sqlite";

export interface TimelineSearchRecord {
  missionId: string;
  missionTitle: string;
  seq: number;
  type: MissionEventType;
  at: number;
  /** Raw FTS snippet of the stored payload; the service redacts and shapes it for display. */
  snippet: string;
}

export interface TimelineSearchRepo {
  /**
   * Every whitespace-separated term must match (prefix match on the last one), accents ignored.
   * User text is never passed as FTS syntax. Newest first. Empty query = no result.
   */
  search(input: { query: string; workspaceId: string | null; missionId: string | null; limit: number }): TimelineSearchRecord[];
}

/** Quotes each term as an FTS5 string (operators and column filters in user text are inert). */
export function toFtsQuery(query: string): string | null {
  const terms = query
    .split(/\s+/)
    .map((term) => term.replace(/"/g, ""))
    .filter((term) => term.length > 0)
    .slice(0, 16);
  if (terms.length === 0) return null;
  return terms.map((term, index) => `"${term}"${index === terms.length - 1 ? "*" : ""}`).join(" ");
}

function toRecord(row: Row): TimelineSearchRecord {
  return {
    missionId: readText(row, "mission_id"),
    missionTitle: readText(row, "title"),
    seq: readNumber(row, "seq"),
    type: readText(row, "type") as MissionEventType,
    at: readNumber(row, "created_at"),
    snippet: readText(row, "snippet"),
  };
}

export function createTimelineSearchRepo(db: DatabaseSync): TimelineSearchRepo {
  return {
    search({ query, workspaceId, missionId, limit }) {
      const match = toFtsQuery(query);
      if (match === null) return [];
      return db
        .prepare(
          `SELECT e.mission_id, m.title, e.seq, e.type, e.created_at,
                  snippet(mission_events_fts, 0, '', '', '…', 24) AS snippet
             FROM mission_events_fts
             JOIN mission_events e ON e.seq = mission_events_fts.rowid
             JOIN missions m ON m.id = e.mission_id
            WHERE mission_events_fts MATCH ?
              AND (? IS NULL OR m.workspace_id = ?)
              AND (? IS NULL OR e.mission_id = ?)
            ORDER BY e.seq DESC
            LIMIT ?`,
        )
        .all(match, workspaceId, workspaceId, missionId, missionId, limit)
        .map(toRecord);
    },
  };
}
