// Versioned schema migrations tracked with `PRAGMA user_version`.
// Append-only: never edit a shipped migration, add a new version instead.
import type { DatabaseSync } from "node:sqlite";
import { withTransaction } from "./sqlite";

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "initial schema",
    sql: `
      CREATE TABLE settings (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL
      ) STRICT;

      CREATE TABLE secrets (
        id TEXT PRIMARY KEY NOT NULL,
        ciphertext BLOB NOT NULL,
        backend TEXT NOT NULL,
        created_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE provider_connections (
        provider_id TEXT PRIMARY KEY NOT NULL,
        secret_ref TEXT REFERENCES secrets(id) ON DELETE SET NULL,
        storage TEXT NOT NULL CHECK (storage IN ('vault', 'weak-vault', 'session')),
        key_hint TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('unverified', 'valid', 'invalid', 'error')),
        last_checked_at INTEGER,
        last_error TEXT,
        check_json TEXT,
        updated_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE model_catalog (
        provider_id TEXT PRIMARY KEY NOT NULL,
        fetched_at INTEGER NOT NULL,
        models_json TEXT NOT NULL
      ) STRICT;

      CREATE TABLE conversations (
        id TEXT PRIMARY KEY NOT NULL,
        title TEXT NOT NULL,
        model_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX conversations_by_updated_at ON conversations (updated_at DESC);

      CREATE TABLE messages (
        id TEXT PRIMARY KEY NOT NULL,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
        content TEXT NOT NULL,
        status TEXT NOT NULL
          CHECK (status IN ('complete', 'streaming', 'stopped', 'error', 'interrupted')),
        model_id TEXT,
        served_model TEXT,
        served_provider TEXT,
        error_json TEXT,
        usage_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE UNIQUE INDEX messages_by_conversation_seq ON messages (conversation_id, seq);

      -- Usage outlives its message (ON DELETE SET NULL): a retried answer was still billed.
      CREATE TABLE usage_records (
        id TEXT PRIMARY KEY NOT NULL,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
        provider_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        served_model TEXT,
        served_provider TEXT,
        prompt_tokens INTEGER,
        completion_tokens INTEGER,
        reasoning_tokens INTEGER,
        cached_tokens INTEGER,
        cost REAL,
        created_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX usage_records_by_conversation ON usage_records (conversation_id);
      CREATE INDEX usage_records_by_message ON usage_records (message_id);
    `,
  },
];

export const SCHEMA_VERSION = MIGRATIONS.length;

/** Thrown when the database was written by a newer NOVA; it is never downgraded. */
export class UnsupportedSchemaError extends Error {
  readonly databaseVersion: number;
  readonly supportedVersion: number;
  constructor(databaseVersion: number, supportedVersion: number) {
    super(
      `Database schema version ${databaseVersion} is newer than the supported version ${supportedVersion}; ` +
        "update NOVA to open it.",
    );
    this.name = "UnsupportedSchemaError";
    this.databaseVersion = databaseVersion;
    this.supportedVersion = supportedVersion;
  }
}

export function readSchemaVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get();
  const version = row?.["user_version"];
  if (typeof version !== "number") throw new Error("PRAGMA user_version returned no number");
  return version;
}

/**
 * Applies the missing migrations in order, each in its own transaction together with its
 * `user_version` bump, so a failing migration leaves the previous version intact.
 * Returns the resulting schema version.
 */
export function migrate(db: DatabaseSync, migrations: readonly Migration[] = MIGRATIONS): number {
  migrations.forEach((migration, index) => {
    if (migration.version !== index + 1) {
      throw new Error(`Migration "${migration.name}" must have version ${index + 1}`);
    }
  });
  const latest = migrations.length;
  const current = readSchemaVersion(db);
  if (current > latest) throw new UnsupportedSchemaError(current, latest);
  for (const migration of migrations.slice(current)) {
    withTransaction(db, () => {
      db.exec(migration.sql);
      // PRAGMA arguments cannot be bound; the version is a validated integer.
      db.exec(`PRAGMA user_version = ${migration.version}`);
    });
  }
  return readSchemaVersion(db);
}
