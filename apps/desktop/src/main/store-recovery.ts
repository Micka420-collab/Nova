// Recovery from a database that cannot be opened: what to tell the user, and how to set a damaged
// file aside. Electron-free so it can be tested; index.ts shows the dialogs.
import { existsSync, renameSync } from "node:fs";
import { UnsupportedSchemaError, isCorruptDatabaseError } from "@nova/storage";

export type StoreOpenFailure = "newer_schema" | "corrupt" | "other";

export function classifyStoreOpenFailure(error: unknown): StoreOpenFailure {
  if (error instanceof UnsupportedSchemaError) return "newer_schema";
  return isCorruptDatabaseError(error) ? "corrupt" : "other";
}

/** Button order of the corrupt-database dialog: index 0 resets, index 1 quits (default, cancel). */
export const CORRUPT_DATABASE_CHOICES = ["Mettre la base de côté et repartir de zéro", "Quitter"] as const;
export const RESET_CHOICE = 0;
export const QUIT_CHOICE = 1;

export function corruptDatabaseMessage(databasePath: string): { title: string; message: string; detail: string } {
  return {
    title: "Base de données endommagée",
    message: "La base de données locale de NOVA est endommagée et ne peut pas être ouverte.",
    detail:
      `Fichier : ${databasePath}\n\n` +
      "« Mettre la base de côté » la renomme (elle n'est pas supprimée) et NOVA repart avec une base vide : " +
      "conversations et réglages ne seront plus affichés, et la clé OpenRouter devra être saisie à nouveau.",
  };
}

/** SQLite keeps a database in up to three files; the journal files belong with the main one. */
const DATABASE_FILE_SUFFIXES = ["", "-wal", "-shm"] as const;

/**
 * Renames the database and its WAL/shared-memory files to `<path>.corrupt-<timestamp>` (+ `-wal`,
 * `-shm`), keeping them together so the copy stays openable. Returns the new paths.
 */
export function quarantineDatabase(databasePath: string, now: Date): string[] {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const moved: string[] = [];
  for (const suffix of DATABASE_FILE_SUFFIXES) {
    const source = `${databasePath}${suffix}`;
    if (!existsSync(source)) continue;
    const target = `${databasePath}.corrupt-${stamp}${suffix}`;
    renameSync(source, target);
    moved.push(target);
  }
  return moved;
}
