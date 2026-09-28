// Skills (M8, J2-B L3): user-installed skills and per-project enablement. Builtin and project
// skills have no row in `skills`; every scope has enablement rows keyed by `<scope>:<name>`.
import type { DatabaseSync } from "node:sqlite";
import type { SkillDeclaredPermissions, SkillRef } from "@nova/shared";
import { readJsonOrNull, readNumber, readText, readTextOrNull, withTransaction, type Row } from "../sqlite";

export interface InstalledSkillRecord {
  name: string;
  description: string;
  version: string | null;
  declared: SkillDeclaredPermissions;
  contentHash: string;
  fileCount: number;
  totalBytes: number;
  /** Folder under <dataDir>/skills (relative). */
  installDir: string;
  installedAt: number;
  updatedAt: number;
}

export type NewInstalledSkill = Omit<InstalledSkillRecord, "installedAt" | "updatedAt">;

export interface SkillEnablementRecord {
  workspaceId: string;
  ref: SkillRef;
  enabled: boolean;
  /** Content hash the user saw when enabling; null = unknown. */
  contentHash: string | null;
  updatedAt: number;
}

export interface SkillRepo {
  /** Installs or replaces (same name) a user skill; `installedAt` is kept on replacement. */
  upsertInstalled(input: NewInstalledSkill): InstalledSkillRecord;
  getInstalled(name: string): InstalledSkillRecord | null;
  /** By name. */
  listInstalled(): InstalledSkillRecord[];
  /**
   * Removes the user skill AND every enablement of `user:<name>` in one transaction (the folder
   * is the runtime's to delete). Returns false when it was not installed.
   */
  uninstall(name: string): boolean;
  setEnabled(workspaceId: string, ref: SkillRef, enabled: boolean, contentHash: string | null): SkillEnablementRecord;
  enablement(workspaceId: string, ref: SkillRef): SkillEnablementRecord | null;
  /** Enablements of a workspace, by ref. */
  listEnablements(workspaceId: string): SkillEnablementRecord[];
}

function toInstalled(row: Row): InstalledSkillRecord {
  return {
    name: readText(row, "name"),
    description: readText(row, "description"),
    version: readTextOrNull(row, "version"),
    declared: readJsonOrNull<SkillDeclaredPermissions>(row, "declared_json") ?? { tools: [], hosts: [], scripts: [] },
    contentHash: readText(row, "content_hash"),
    fileCount: readNumber(row, "file_count"),
    totalBytes: readNumber(row, "total_bytes"),
    installDir: readText(row, "install_dir"),
    installedAt: readNumber(row, "installed_at"),
    updatedAt: readNumber(row, "updated_at"),
  };
}

function toEnablement(row: Row): SkillEnablementRecord {
  return {
    workspaceId: readText(row, "workspace_id"),
    // Guarded by the CHECK constraint on skill_ref.
    ref: readText(row, "skill_ref") as SkillRef,
    enabled: readNumber(row, "enabled") === 1,
    contentHash: readTextOrNull(row, "content_hash"),
    updatedAt: readNumber(row, "updated_at"),
  };
}

export function createSkillRepo(db: DatabaseSync, now: () => number = Date.now): SkillRepo {
  const getInstalled = (name: string): InstalledSkillRecord | null => {
    const row = db.prepare("SELECT * FROM skills WHERE name = ?").get(name);
    return row ? toInstalled(row) : null;
  };
  const enablement = (workspaceId: string, ref: SkillRef): SkillEnablementRecord | null => {
    const row = db.prepare("SELECT * FROM skill_enablements WHERE workspace_id = ? AND skill_ref = ?").get(workspaceId, ref);
    return row ? toEnablement(row) : null;
  };

  return {
    upsertInstalled(input) {
      const time = now();
      db.prepare(
        `INSERT INTO skills (name, description, version, declared_json, content_hash, file_count, total_bytes,
           install_dir, installed_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (name) DO UPDATE SET description = excluded.description, version = excluded.version,
           declared_json = excluded.declared_json, content_hash = excluded.content_hash,
           file_count = excluded.file_count, total_bytes = excluded.total_bytes,
           install_dir = excluded.install_dir, updated_at = excluded.updated_at`,
      ).run(
        input.name,
        input.description,
        input.version,
        JSON.stringify(input.declared),
        input.contentHash,
        input.fileCount,
        input.totalBytes,
        input.installDir,
        time,
        time,
      );
      const stored = getInstalled(input.name);
      if (!stored) throw new Error("Installed skill not found");
      return stored;
    },

    getInstalled,

    listInstalled() {
      return db.prepare("SELECT * FROM skills ORDER BY name").all().map(toInstalled);
    },

    uninstall(name) {
      return withTransaction(db, () => {
        db.prepare("DELETE FROM skill_enablements WHERE skill_ref = ?").run(`user:${name}`);
        return Number(db.prepare("DELETE FROM skills WHERE name = ?").run(name).changes) > 0;
      });
    },

    setEnabled(workspaceId, ref, enabled, contentHash) {
      db.prepare(
        `INSERT INTO skill_enablements (workspace_id, skill_ref, enabled, content_hash, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (workspace_id, skill_ref) DO UPDATE SET enabled = excluded.enabled,
           content_hash = excluded.content_hash, updated_at = excluded.updated_at`,
      ).run(workspaceId, ref, enabled ? 1 : 0, contentHash, now());
      const stored = enablement(workspaceId, ref);
      if (!stored) throw new Error("Skill enablement not found");
      return stored;
    },

    enablement,

    listEnablements(workspaceId) {
      return db.prepare("SELECT * FROM skill_enablements WHERE workspace_id = ? ORDER BY skill_ref").all(workspaceId).map(toEnablement);
    },
  };
}
