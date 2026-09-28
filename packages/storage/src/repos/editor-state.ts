// Editor layout per workspace (Pr3): open tabs, pinned tabs, active tab, split sizes… The shape is
// owned by the renderer; stored as JSON and returned as-is (never file contents: paths only).
import type { DatabaseSync } from "node:sqlite";
import { readNumber, readText } from "../sqlite";

export interface EditorStateRecord {
  workspaceId: string;
  state: unknown;
  updatedAt: number;
}

export interface EditorStateRepo {
  get(workspaceId: string): EditorStateRecord | null;
  put(workspaceId: string, state: unknown): EditorStateRecord;
}

/** Guards the column against accidental blobs (the state is a small layout description). */
export const EDITOR_STATE_MAX_CHARS = 256 * 1024;

export function createEditorStateRepo(db: DatabaseSync, now: () => number = Date.now): EditorStateRepo {
  return {
    get(workspaceId) {
      const row = db.prepare("SELECT * FROM editor_state WHERE workspace_id = ?").get(workspaceId);
      if (!row) return null;
      return {
        workspaceId,
        state: JSON.parse(readText(row, "state_json")) as unknown,
        updatedAt: readNumber(row, "updated_at"),
      };
    },

    put(workspaceId, state) {
      const json = JSON.stringify(state);
      if (json === undefined) throw new Error("Editor state must be JSON-serializable");
      if (json.length > EDITOR_STATE_MAX_CHARS) throw new Error("Editor state is too large");
      const updatedAt = now();
      db.prepare(
        `INSERT INTO editor_state (workspace_id, state_json, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (workspace_id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at`,
      ).run(workspaceId, json, updatedAt);
      return { workspaceId, state: JSON.parse(json) as unknown, updatedAt };
    },
  };
}
