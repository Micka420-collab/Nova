// Workspaces: folders opened in NOVA (E1). root_path never leaves the main process.
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { readNumber, readText, readTextOrNull, type Row } from "../sqlite";

/** Mirrors the permission profile union of @nova/shared. */
export type PermissionProfileValue = "read_only" | "assisted" | "autonomous" | "custom";
/** Consent to read AGENTS.md / CLAUDE.md / .cursorrules (D10); null = never asked. */
export type InstructionFilesConsentValue = "allowed" | "denied";

export interface WorkspaceRecord {
  id: string;
  /** Absolute realpath; main process only, never sent to the renderer. */
  rootPath: string;
  name: string;
  permissionProfile: PermissionProfileValue;
  instructionFilesConsent: InstructionFilesConsentValue | null;
  createdAt: number;
  lastOpenedAt: number;
}

export interface WorkspaceRepo {
  /** Records an opened folder: inserts it, or renames it and bumps `lastOpenedAt`. */
  upsertByRootPath(input: { rootPath: string; name: string }): WorkspaceRecord;
  get(id: string): WorkspaceRecord | null;
  /** Most recently opened first (default limit 20). */
  listRecent(limit?: number): WorkspaceRecord[];
}

const DEFAULT_RECENT_LIMIT = 20;

function toWorkspace(row: Row): WorkspaceRecord {
  return {
    id: readText(row, "id"),
    rootPath: readText(row, "root_path"),
    name: readText(row, "name"),
    // Enum columns are guarded by CHECK constraints.
    permissionProfile: readText(row, "permission_profile") as PermissionProfileValue,
    instructionFilesConsent: readTextOrNull(row, "instruction_files_consent") as
      | InstructionFilesConsentValue
      | null,
    createdAt: readNumber(row, "created_at"),
    lastOpenedAt: readNumber(row, "last_opened_at"),
  };
}

export function createWorkspaceRepo(db: DatabaseSync, now: () => number = Date.now): WorkspaceRepo {
  return {
    upsertByRootPath({ rootPath, name }) {
      // The caller resolves the realpath; a relative path would silently duplicate workspaces.
      if (!isAbsolute(rootPath)) throw new Error("Workspace root path must be absolute");
      const time = now();
      const row = db
        .prepare(
          `INSERT INTO workspaces (id, root_path, name, created_at, last_opened_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (root_path) DO UPDATE SET name = excluded.name, last_opened_at = excluded.last_opened_at
           RETURNING *`,
        )
        .get(randomUUID(), rootPath, name, time, time);
      if (!row) throw new Error("Workspace upsert returned no row");
      return toWorkspace(row);
    },

    get(id) {
      const row = db.prepare("SELECT * FROM workspaces WHERE id = ?").get(id);
      return row ? toWorkspace(row) : null;
    },

    listRecent(limit = DEFAULT_RECENT_LIMIT) {
      return db
        .prepare("SELECT * FROM workspaces ORDER BY last_opened_at DESC, rowid DESC LIMIT ?")
        .all(limit)
        .map(toWorkspace);
    },
  };
}
