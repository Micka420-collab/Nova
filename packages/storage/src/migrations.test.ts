import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MIGRATIONS,
  SCHEMA_VERSION,
  UnsupportedSchemaError,
  migrate,
  readSchemaVersion,
  type Migration,
} from "./migrations";
import { openNovaStore } from "./nova-store";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nova-migrations-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function tableNames(db: DatabaseSync): string[] {
  return db
    .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
    .all()
    .map((row) => String(row["name"]));
}

describe("migrations", () => {
  it("creates the schema on a fresh file database and reopens it without reapplying", () => {
    const file = join(dir, "nova.db");
    const store = openNovaStore(file);
    expect(store.path).toBe(file);
    const conversation = store.createConversation({ title: "Persistée", modelId: null });
    store.close();

    const raw = new DatabaseSync(file);
    expect(readSchemaVersion(raw)).toBe(SCHEMA_VERSION);
    expect(raw.prepare("PRAGMA journal_mode").get()?.["journal_mode"]).toBe("wal");
    expect(tableNames(raw)).toEqual([
      "conversations",
      "messages",
      "model_catalog",
      "provider_connections",
      "secrets",
      "settings",
      "usage_records",
    ]);
    raw.close();

    const reopened = openNovaStore(file);
    expect(reopened.getConversation(conversation.id)).toEqual(conversation);
    reopened.close();
  });

  it("applies only the missing migrations", () => {
    const db = new DatabaseSync(":memory:");
    expect(migrate(db, MIGRATIONS.slice(0, 1))).toBe(1);
    const next: Migration = { version: 2, name: "extra", sql: "CREATE TABLE extra (x INTEGER) STRICT;" };
    // Re-running version 1 would fail on CREATE TABLE settings.
    expect(migrate(db, [...MIGRATIONS.slice(0, 1), next])).toBe(2);
    expect(tableNames(db)).toContain("extra");
    expect(migrate(db, [...MIGRATIONS.slice(0, 1), next])).toBe(2);
    db.close();
  });

  it("rolls back a failing migration together with its version bump", () => {
    const db = new DatabaseSync(":memory:");
    const broken: Migration = {
      version: 2,
      name: "broken",
      sql: "CREATE TABLE half_done (x INTEGER) STRICT; CREATE TABLE oops (;",
    };
    expect(() => migrate(db, [...MIGRATIONS.slice(0, 1), broken])).toThrow(/syntax error/);
    expect(readSchemaVersion(db)).toBe(1);
    expect(tableNames(db)).not.toContain("half_done");
    expect(db.isTransaction).toBe(false);
    db.close();
  });

  it("rejects non-contiguous migration versions", () => {
    const db = new DatabaseSync(":memory:");
    expect(() => migrate(db, [{ version: 2, name: "gap", sql: "" }])).toThrow(/must have version 1/);
    db.close();
  });

  it("refuses a database written by a newer version and leaves it untouched", () => {
    const file = join(dir, "future.db");
    const raw = new DatabaseSync(file);
    raw.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 5}`);
    raw.close();

    let error: unknown;
    try {
      openNovaStore(file);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(UnsupportedSchemaError);
    expect(error).toMatchObject({
      databaseVersion: SCHEMA_VERSION + 5,
      supportedVersion: SCHEMA_VERSION,
    });

    const after = new DatabaseSync(file);
    expect(readSchemaVersion(after)).toBe(SCHEMA_VERSION + 5);
    expect(tableNames(after)).toEqual([]);
    expect(after.prepare("PRAGMA journal_mode").get()?.["journal_mode"]).toBe("delete");
    after.close();
  });
});
