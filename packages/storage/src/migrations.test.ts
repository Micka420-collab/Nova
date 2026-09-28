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

const LATEST_TABLES = [
  "approvals",
  "artifacts",
  "audit_log",
  "checkpoint_files",
  "checkpoints",
  "conversations",
  "cost_reservations",
  "editor_state",
  "mcp_servers",
  "mcp_tool_permissions",
  "mcp_tools_cache",
  "memory_items",
  "messages",
  "mission_contracts",
  "mission_events",
  "mission_tasks",
  "missions",
  "model_catalog",
  "policies",
  "proofs",
  "provider_connections",
  "review_decisions",
  "routing_profiles",
  "secrets",
  "settings",
  "signals",
  // Created by the AUTOINCREMENT of mission_events and audit_log.
  "sqlite_sequence",
  "suggestions",
  "tool_calls",
  "usage_records",
  "web_cache",
  "web_policy_rules",
  "workspace_facts",
  "workspaces",
];

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
    expect(tableNames(raw)).toEqual(LATEST_TABLES);
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

/** Plain-object snapshot of a table (node:sqlite rows have a null prototype). */
function snapshot(db: DatabaseSync, table: string, orderBy: string): Record<string, unknown>[] {
  return db
    .prepare(`SELECT * FROM ${table} ORDER BY ${orderBy}`)
    .all()
    .map((row) => ({ ...row }));
}

function indexNames(db: DatabaseSync, table: string): string[] {
  return db
    .prepare("SELECT name FROM sqlite_schema WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL ORDER BY name")
    .all(table)
    .map((row) => String(row["name"]));
}

/** A version 1 database with one row of every kind, written with raw SQL as v1 NOVA did. */
function populateV1(db: DatabaseSync): void {
  db.exec("PRAGMA foreign_keys = ON");
  expect(migrate(db, MIGRATIONS.slice(0, 1))).toBe(1);
  db.exec(`
    INSERT INTO settings (key, value) VALUES ('theme', '"dark"');
    INSERT INTO secrets (id, ciphertext, backend, created_at) VALUES ('sec-1', x'DEADBEEF', 'basic_text', 10);
    INSERT INTO provider_connections (provider_id, secret_ref, storage, key_hint, state, updated_at)
      VALUES ('openrouter', 'sec-1', 'vault', '…abcd', 'valid', 11);
    INSERT INTO model_catalog (provider_id, fetched_at, models_json) VALUES ('openrouter', 12, '[]');
    INSERT INTO conversations (id, title, model_id, created_at, updated_at)
      VALUES ('conv-1', 'Ancienne', 'vendor/model', 20, 30);
    INSERT INTO messages (id, conversation_id, seq, role, content, status, created_at, updated_at)
      VALUES ('msg-1', 'conv-1', 1, 'user', 'Bonjour', 'complete', 21, 21),
             ('msg-2', 'conv-1', 2, 'assistant', 'Salut', 'complete', 22, 23);
    INSERT INTO usage_records (id, conversation_id, message_id, provider_id, model_id,
        prompt_tokens, completion_tokens, cost, created_at)
      VALUES ('use-1', 'conv-1', 'msg-2', 'openrouter', 'vendor/model', 5, 7, 0.25, 24),
             ('use-2', 'conv-1', NULL, 'openrouter', 'vendor/model', NULL, NULL, NULL, 25);
  `);
}

const V1_TABLES: Record<string, string> = {
  settings: "key",
  secrets: "id",
  provider_connections: "provider_id",
  model_catalog: "provider_id",
  conversations: "id",
  messages: "id",
};

describe("migrations v2 to v5", () => {
  it("opens a fresh database at the latest version", () => {
    const store = openNovaStore(":memory:");
    expect(SCHEMA_VERSION).toBe(5);
    expect(readSchemaVersion(store.db)).toBe(5);
    expect(tableNames(store.db)).toEqual(LATEST_TABLES);
    store.close();
  });

  it("upgrades a populated version 1 file database without losing any row", () => {
    const file = join(dir, "v1.db");
    const raw = new DatabaseSync(file);
    populateV1(raw);
    const before = Object.fromEntries(
      Object.entries(V1_TABLES).map(([table, key]) => [table, snapshot(raw, table, key)]),
    );
    const usageBefore = snapshot(raw, "usage_records", "id");
    raw.close();

    const store = openNovaStore(file);
    expect(readSchemaVersion(store.db)).toBe(SCHEMA_VERSION);
    for (const [table, key] of Object.entries(V1_TABLES)) {
      expect(snapshot(store.db, table, key)).toEqual(before[table]);
    }
    expect(snapshot(store.db, "usage_records", "id")).toEqual(
      usageBefore.map((row) => ({ ...row, mission_id: null, tool_call_id: null, kind: "generation" })),
    );
    expect(indexNames(store.db, "usage_records")).toEqual([
      "usage_records_by_conversation",
      "usage_records_by_message",
      "usage_records_by_mission",
      "usage_records_by_tool_call",
    ]);
    expect(store.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(store.db.prepare("PRAGMA integrity_check").get()?.["integrity_check"]).toBe("ok");

    // The v1 API still works on the upgraded data.
    expect(store.getSettings().theme).toBe("dark");
    expect(store.getSecret("sec-1")?.ciphertext).toEqual(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
    expect(store.listMessages("conv-1").map((message) => message.id)).toEqual(["msg-1", "msg-2"]);
    expect(store.conversationUsage("conv-1")).toMatchObject({
      promptTokens: 5,
      completionTokens: 7,
      cost: 0.25,
      messagesWithUnknownCost: 1,
    });
    // Usage without a conversation (e.g. a web search) is now recordable.
    store.db
      .prepare(
        `INSERT INTO usage_records (id, kind, provider_id, model_id, cost, created_at)
         VALUES ('use-3', 'web_search', 'openrouter', 'vendor/model', 0.01, 40)`,
      )
      .run();
    // Deleting the conversation still cascades to its usage records only.
    expect(store.deleteConversation("conv-1")).toBe(true);
    expect(snapshot(store.db, "usage_records", "id").map((row) => row["id"])).toEqual(["use-3"]);
    store.close();
  });

  it("applies each migration step on its own", () => {
    const db = new DatabaseSync(":memory:");
    populateV1(db);
    for (let version = 2; version <= SCHEMA_VERSION; version += 1) {
      expect(migrate(db, MIGRATIONS.slice(0, version))).toBe(version);
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    }
    expect(tableNames(db)).toEqual(LATEST_TABLES);
    expect(snapshot(db, "usage_records", "id").map((row) => row["kind"])).toEqual(["generation", "generation"]);
    db.close();
  });
});

describe("schema constraints", () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = openNovaStore(":memory:").db;
    db.exec(`
      INSERT INTO workspaces (id, root_path, name, created_at, last_opened_at)
        VALUES ('ws-1', '/home/u/projet', 'projet', 1, 1);
      INSERT INTO missions (id, workspace_id, title, goal, mode, state, created_at, updated_at)
        VALUES ('m-1', 'ws-1', 'Panier', 'Corriger le total', 'fix', 'ready', 1, 1);
    `);
  });
  afterEach(() => {
    db.close();
  });

  it.each([
    [
      "missions.mode",
      `INSERT INTO missions (id, workspace_id, title, goal, mode, state, created_at, updated_at)
       VALUES ('m-2', 'ws-1', 't', 'g', 'yolo', 'ready', 1, 1)`,
    ],
    [
      "missions.state",
      `INSERT INTO missions (id, workspace_id, title, goal, mode, state, created_at, updated_at)
       VALUES ('m-2', 'ws-1', 't', 'g', 'fix', 'waiting-approval', 1, 1)`,
    ],
    [
      "tool_calls.operation",
      `INSERT INTO tool_calls (id, mission_id, tool, operation, arguments_json, state, requested_at)
       VALUES ('t-1', 'm-1', 'write_file', 'rm_rf', '{}', 'requested', 1)`,
    ],
    [
      "workspaces.instruction_files_consent",
      "UPDATE workspaces SET instruction_files_consent = 'maybe'",
    ],
    [
      "signals.kind",
      `INSERT INTO signals (id, kind, source_ref, evidence_json, state, created_at)
       VALUES ('s-1', 'vibes', 'x', '{}', 'new', 1)`,
    ],
    [
      "mcp_servers.enabled",
      `INSERT INTO mcp_servers (id, name, scope, transport, config_json, enabled, created_at, updated_at)
       VALUES ('srv-1', 'fs', 'global', 'stdio', '{}', 2, 1, 1)`,
    ],
    [
      "mcp_servers scope/workspace consistency",
      `INSERT INTO mcp_servers (id, name, scope, transport, config_json, enabled, created_at, updated_at)
       VALUES ('srv-1', 'fs', 'workspace', 'stdio', '{}', 1, 1, 1)`,
    ],
    [
      "mission_events.payload_json",
      `INSERT INTO mission_events (id, mission_id, type, payload_json, created_at)
       VALUES ('e-1', 'm-1', 'x', '{not json', 1)`,
    ],
  ])("rejects an invalid %s", (_name, sql) => {
    expect(() => db.exec(sql)).toThrow(/CHECK constraint failed/);
  });

  it("treats a NULL workspace as one scope in the uniqueness of nullable keys", () => {
    db.exec(`
      INSERT INTO mcp_servers (id, name, scope, transport, config_json, enabled, created_at, updated_at)
        VALUES ('srv-1', 'fs', 'global', 'stdio', '{}', 1, 1, 1);
      INSERT INTO mcp_tool_permissions (server_id, tool_name, workspace_id, permission, updated_at)
        VALUES ('srv-1', 'read_file', NULL, 'allow', 1), ('srv-1', 'read_file', 'ws-1', 'ask', 1);
    `);
    const upsert = db.prepare(
      `INSERT INTO mcp_tool_permissions (server_id, tool_name, workspace_id, permission, updated_at)
       VALUES ('srv-1', 'read_file', NULL, 'deny', 2)
       ON CONFLICT (server_id, tool_name, coalesce(workspace_id, '')) DO UPDATE
         SET permission = excluded.permission, updated_at = excluded.updated_at`,
    );
    upsert.run();
    expect(snapshot(db, "mcp_tool_permissions", "workspace_id").map((row) => row["permission"])).toEqual([
      "deny",
      "ask",
    ]);
    const decide = `INSERT INTO review_decisions (id, mission_id, path, hunk_index, decision, decided_at)
                    VALUES (?, 'm-1', 'src/cart.ts', NULL, 'kept', 1)`;
    db.prepare(decide).run("r-1");
    expect(() => db.prepare(decide).run("r-2")).toThrow(/UNIQUE constraint failed/);
    const makeDefault = `INSERT INTO routing_profiles (id, name, rules_json, is_default, created_at, updated_at)
                         VALUES (?, ?, '[]', 1, 1, 1)`;
    db.prepare(makeDefault).run("p-1", "Équilibré");
    expect(() => db.prepare(makeDefault).run("p-2", "Économe")).toThrow(/UNIQUE constraint failed/);
  });

  it("cascades a workspace deletion to its missions and their journal, but keeps the audit log", () => {
    db.exec(`
      INSERT INTO mission_contracts (mission_id, profile, isolation_level, allowed_operations_json,
          allowed_hosts_json, created_at)
        VALUES ('m-1', 'assisted', 'L0', '["read"]', '[]', 1);
      INSERT INTO mission_events (id, mission_id, type, payload_json, created_at)
        VALUES ('e-1', 'm-1', 'mission.created', '{}', 1);
      INSERT INTO tool_calls (id, mission_id, tool, operation, arguments_json, state, requested_at)
        VALUES ('t-1', 'm-1', 'read_file', 'read', '{}', 'succeeded', 1);
      INSERT INTO approvals (id, workspace_id, mission_id, tool_call_id, request_json, status, created_at)
        VALUES ('a-1', 'ws-1', 'm-1', 't-1', '{}', 'pending', 1);
      INSERT INTO usage_records (id, mission_id, tool_call_id, provider_id, model_id, created_at)
        VALUES ('u-1', 'm-1', 't-1', 'openrouter', 'vendor/model', 1);
      INSERT INTO audit_log (created_at, workspace_id, mission_id, actor, action, decision)
        VALUES (1, 'ws-1', 'm-1', 'agent', 'read_file', 'allow');
    `);
    db.exec("DELETE FROM workspaces WHERE id = 'ws-1'");
    for (const table of ["missions", "mission_contracts", "mission_events", "tool_calls", "approvals"]) {
      expect(snapshot(db, table, "rowid")).toEqual([]);
    }
    // Billed usage outlives the mission; the audit trail has no foreign keys.
    expect(snapshot(db, "usage_records", "id")).toMatchObject([{ id: "u-1", mission_id: null, tool_call_id: null }]);
    expect(snapshot(db, "audit_log", "seq")).toMatchObject([{ mission_id: "m-1", action: "read_file" }]);
  });
});
