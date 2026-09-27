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
  {
    // Workspaces (E1), editor layout (Pr3), checkpoints (A10) and produced artifacts (F7).
    // Checkpoint object bytes live in dataDir/checkpoints/objects/<sha256>, never in SQLite;
    // project files are never stored here, only relative paths and content hashes.
    version: 2,
    name: "workspace",
    sql: `
      -- root_path is the absolute realpath of the opened folder: main process only, never
      -- sent to the renderer. instruction_files_consent: NULL = never asked (D10).
      CREATE TABLE workspaces (
        id TEXT PRIMARY KEY NOT NULL,
        root_path TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        permission_profile TEXT NOT NULL DEFAULT 'assisted'
          CHECK (permission_profile IN ('read_only', 'assisted', 'autonomous', 'custom')),
        instruction_files_consent TEXT CHECK (instruction_files_consent IN ('allowed', 'denied')),
        created_at INTEGER NOT NULL,
        last_opened_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX workspaces_by_last_opened_at ON workspaces (last_opened_at DESC);

      CREATE TABLE workspace_facts (
        workspace_id TEXT PRIMARY KEY NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        facts_json TEXT NOT NULL CHECK (json_valid(facts_json)),
        detected_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE editor_state (
        workspace_id TEXT PRIMARY KEY NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        state_json TEXT NOT NULL CHECK (json_valid(state_json)),
        updated_at INTEGER NOT NULL
      ) STRICT;

      -- mission_id has no foreign key: missions arrive in v3 and SQLite cannot add one later.
      CREATE TABLE checkpoints (
        id TEXT PRIMARY KEY NOT NULL,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        mission_id TEXT,
        label TEXT NOT NULL,
        reason TEXT NOT NULL CHECK (reason IN ('tool_write', 'user_replace', 'before_restore', 'manual')),
        created_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX checkpoints_by_workspace ON checkpoints (workspace_id, created_at);
      CREATE INDEX checkpoints_by_mission ON checkpoints (mission_id);

      -- path is relative to the workspace root. before_hash NULL: the file did not exist;
      -- after_hash NULL: the write deleted it. Hashes are sha256 hex of the object store.
      CREATE TABLE checkpoint_files (
        checkpoint_id TEXT NOT NULL REFERENCES checkpoints(id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        before_hash TEXT,
        after_hash TEXT,
        user_hash_seen TEXT,
        PRIMARY KEY (checkpoint_id, path)
      ) STRICT;

      -- Content lives in dataDir, addressed by content_hash. mission_id: no FK (see checkpoints).
      CREATE TABLE artifacts (
        id TEXT PRIMARY KEY NOT NULL,
        workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
        mission_id TEXT,
        kind TEXT NOT NULL CHECK (kind IN ('report', 'screenshot', 'export', 'log')),
        title TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
        mime TEXT NOT NULL,
        created_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX artifacts_by_workspace ON artifacts (workspace_id, created_at DESC);
      CREATE INDEX artifacts_by_mission ON artifacts (mission_id);
    `,
  },
  {
    // Agent loop (A9), contract and budget (A13, Mo5), permissions (S1), audit (S5), review (A11).
    version: 3,
    name: "missions",
    sql: `
      CREATE TABLE missions (
        id TEXT PRIMARY KEY NOT NULL,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
        title TEXT NOT NULL,
        goal TEXT NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('discuss', 'understand', 'plan', 'build', 'fix', 'verify')),
        state TEXT NOT NULL CHECK (state IN
          ('ready', 'running', 'waiting_approval', 'suspended', 'succeeded', 'failed', 'cancelled')),
        model_id TEXT,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        ended_at INTEGER,
        updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX missions_by_workspace ON missions (workspace_id, updated_at DESC);
      CREATE INDEX missions_by_conversation ON missions (conversation_id);
      CREATE INDEX missions_by_state ON missions (state);

      -- max_duration_ms / budget_usd NULL: no cap was set in the contract.
      CREATE TABLE mission_contracts (
        mission_id TEXT PRIMARY KEY NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
        profile TEXT NOT NULL CHECK (profile IN ('read_only', 'assisted', 'autonomous', 'custom')),
        isolation_level TEXT NOT NULL CHECK (isolation_level IN ('L0', 'L1', 'L2')),
        allowed_operations_json TEXT NOT NULL CHECK (json_valid(allowed_operations_json)),
        allowed_hosts_json TEXT NOT NULL CHECK (json_valid(allowed_hosts_json)),
        max_duration_ms INTEGER CHECK (max_duration_ms > 0),
        budget_usd REAL CHECK (budget_usd >= 0),
        created_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE mission_tasks (
        id TEXT PRIMARY KEY NOT NULL,
        mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        title TEXT NOT NULL,
        state TEXT NOT NULL
          CHECK (state IN ('todo', 'running', 'verified', 'failed', 'blocked', 'skipped')),
        acceptance_kind TEXT NOT NULL
          CHECK (acceptance_kind IN ('test_passes', 'command_succeeds', 'file_exists', 'manual')),
        acceptance_detail TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (mission_id, seq)
      ) STRICT;

      -- Append-only journal, source of truth for the mission card and resume. seq is global and
      -- monotonic (AUTOINCREMENT never reuses a value), so it orders events within a mission.
      CREATE TABLE mission_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
        created_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX mission_events_by_mission ON mission_events (mission_id, seq);

      CREATE TABLE tool_calls (
        id TEXT PRIMARY KEY NOT NULL,
        mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
        tool TEXT NOT NULL,
        operation TEXT NOT NULL CHECK (operation IN
          ('read', 'write', 'delete', 'execute', 'network', 'git_mutation', 'external')),
        arguments_json TEXT NOT NULL CHECK (json_valid(arguments_json)),
        state TEXT NOT NULL
          CHECK (state IN ('requested', 'denied', 'running', 'succeeded', 'failed', 'cancelled')),
        decision TEXT CHECK (decision IN ('allow', 'ask', 'deny')),
        rule_id TEXT,
        exit_code INTEGER,
        result_summary TEXT,
        requested_at INTEGER NOT NULL,
        started_at INTEGER,
        finished_at INTEGER
      ) STRICT;
      CREATE INDEX tool_calls_by_mission ON tool_calls (mission_id, requested_at);

      -- output_ref points to an artifact / object in dataDir; command output is never inlined.
      CREATE TABLE proofs (
        id TEXT PRIMARY KEY NOT NULL,
        mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
        task_id TEXT REFERENCES mission_tasks(id) ON DELETE SET NULL,
        tool_call_id TEXT REFERENCES tool_calls(id) ON DELETE SET NULL,
        kind TEXT NOT NULL CHECK (kind IN ('command', 'test', 'screenshot', 'diff')),
        command TEXT,
        exit_code INTEGER,
        summary TEXT NOT NULL,
        output_ref TEXT,
        created_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX proofs_by_mission ON proofs (mission_id, created_at);
      CREATE INDEX proofs_by_task ON proofs (task_id);
      CREATE INDEX proofs_by_tool_call ON proofs (tool_call_id);

      CREATE TABLE approvals (
        id TEXT PRIMARY KEY NOT NULL,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        mission_id TEXT REFERENCES missions(id) ON DELETE CASCADE,
        tool_call_id TEXT REFERENCES tool_calls(id) ON DELETE SET NULL,
        request_json TEXT NOT NULL CHECK (json_valid(request_json)),
        status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'expired')),
        scope TEXT CHECK (scope IN ('once', 'mission', 'project')),
        rule_id TEXT,
        created_at INTEGER NOT NULL,
        decided_at INTEGER,
        expires_at INTEGER
      ) STRICT;
      CREATE INDEX approvals_by_workspace_status ON approvals (workspace_id, status, created_at);
      CREATE INDEX approvals_by_mission ON approvals (mission_id);
      CREATE INDEX approvals_by_tool_call ON approvals (tool_call_id);

      -- Remembered decisions and profile/contract rules. workspace_id NULL = global rule;
      -- mission_id is set for scope 'mission' rules (e.g. from the mission contract) and makes
      -- them disappear with the mission. NULL matchers (tool, operation…) match anything.
      CREATE TABLE policies (
        id TEXT PRIMARY KEY NOT NULL,
        workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
        mission_id TEXT REFERENCES missions(id) ON DELETE CASCADE,
        tool TEXT,
        operation TEXT CHECK (operation IN
          ('read', 'write', 'delete', 'execute', 'network', 'git_mutation', 'external')),
        path_glob TEXT,
        host TEXT,
        decision TEXT NOT NULL CHECK (decision IN ('allow', 'ask', 'deny')),
        scope TEXT NOT NULL CHECK (scope IN ('once', 'mission', 'project')),
        source TEXT NOT NULL CHECK (source IN ('user', 'profile', 'contract', 'default')),
        created_at INTEGER NOT NULL,
        expires_at INTEGER
      ) STRICT;
      CREATE INDEX policies_by_workspace ON policies (workspace_id);
      CREATE INDEX policies_by_mission ON policies (mission_id);

      -- Append-only. No foreign keys on purpose: the audit trail survives deleted workspaces,
      -- missions and tool calls. target is a workspace-relative path or a host; data_summary_json
      -- holds sizes and types only, never content.
      CREATE TABLE audit_log (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at INTEGER NOT NULL,
        workspace_id TEXT,
        mission_id TEXT,
        tool_call_id TEXT,
        actor TEXT NOT NULL CHECK (actor IN ('user', 'agent', 'system')),
        action TEXT NOT NULL,
        decision TEXT CHECK (decision IN ('allow', 'ask', 'deny')),
        rule_id TEXT,
        target TEXT,
        data_summary_json TEXT CHECK (json_valid(data_summary_json)),
        cost REAL,
        outcome TEXT
      ) STRICT;
      CREATE INDEX audit_log_by_created_at ON audit_log (created_at);
      CREATE INDEX audit_log_by_workspace ON audit_log (workspace_id, created_at);
      CREATE INDEX audit_log_by_mission ON audit_log (mission_id);

      -- hunk_index NULL = decision on the whole file. The unique index maps NULL to -1 because
      -- SQLite treats NULLs as distinct in UNIQUE constraints.
      CREATE TABLE review_decisions (
        id TEXT PRIMARY KEY NOT NULL,
        mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        hunk_index INTEGER CHECK (hunk_index >= 0),
        decision TEXT NOT NULL CHECK (decision IN ('kept', 'reverted')),
        decided_at INTEGER NOT NULL
      ) STRICT;
      CREATE UNIQUE INDEX review_decisions_by_target
        ON review_decisions (mission_id, path, coalesce(hunk_index, -1));

      CREATE TABLE cost_reservations (
        id TEXT PRIMARY KEY NOT NULL,
        mission_id TEXT REFERENCES missions(id) ON DELETE CASCADE,
        amount_usd REAL NOT NULL CHECK (amount_usd >= 0),
        status TEXT NOT NULL CHECK (status IN ('reserved', 'committed', 'released')),
        created_at INTEGER NOT NULL,
        settled_at INTEGER,
        settled_amount_usd REAL CHECK (settled_amount_usd >= 0)
      ) STRICT;
      CREATE INDEX cost_reservations_by_mission ON cost_reservations (mission_id, status);

      -- usage_records is rebuilt (SQLite cannot drop NOT NULL with ALTER TABLE): conversation_id
      -- becomes nullable so mission and web usage without a conversation can be recorded, and
      -- mission_id / tool_call_id / kind are added. Every v1 row is copied with its id, becomes
      -- kind 'generation' with NULL mission_id and tool_call_id. No table references
      -- usage_records, so dropping the old table is safe with foreign_keys = ON.
      CREATE TABLE usage_records_v3 (
        id TEXT PRIMARY KEY NOT NULL,
        conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
        message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
        mission_id TEXT REFERENCES missions(id) ON DELETE SET NULL,
        tool_call_id TEXT REFERENCES tool_calls(id) ON DELETE SET NULL,
        kind TEXT NOT NULL DEFAULT 'generation'
          CHECK (kind IN ('generation', 'web_search', 'ocr', 'embedding')),
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
      INSERT INTO usage_records_v3
        (id, conversation_id, message_id, provider_id, model_id, served_model, served_provider,
         prompt_tokens, completion_tokens, reasoning_tokens, cached_tokens, cost, created_at)
      SELECT id, conversation_id, message_id, provider_id, model_id, served_model, served_provider,
        prompt_tokens, completion_tokens, reasoning_tokens, cached_tokens, cost, created_at
      FROM usage_records;
      DROP TABLE usage_records;
      ALTER TABLE usage_records_v3 RENAME TO usage_records;
      CREATE INDEX usage_records_by_conversation ON usage_records (conversation_id);
      CREATE INDEX usage_records_by_message ON usage_records (message_id);
      CREATE INDEX usage_records_by_mission ON usage_records (mission_id);
      CREATE INDEX usage_records_by_tool_call ON usage_records (tool_call_id);
    `,
  },
  {
    // MCP servers and permissions (M1, M3, M5) and the Internet domain policy (W4) with its cache.
    // Nullable workspace_id in uniqueness is handled with coalesce(workspace_id, '') expression
    // indexes (SQLite treats NULLs as distinct in UNIQUE); workspace ids are never ''.
    version: 4,
    name: "connectors",
    sql: `
      -- config_json holds command/args/url; env and header values are secret references
      -- ({"secretRef": "<secrets.id>"}) only, never the values themselves.
      CREATE TABLE mcp_servers (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
        scope TEXT NOT NULL CHECK (scope IN ('global', 'workspace')),
        transport TEXT NOT NULL CHECK (transport IN ('stdio', 'http')),
        config_json TEXT NOT NULL CHECK (json_valid(config_json)),
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        CHECK ((scope = 'workspace') = (workspace_id IS NOT NULL))
      ) STRICT;
      CREATE UNIQUE INDEX mcp_servers_by_name ON mcp_servers (coalesce(workspace_id, ''), name);
      CREATE INDEX mcp_servers_by_workspace ON mcp_servers (workspace_id);

      -- workspace_id NULL = default for every workspace. Upserts target the expression index:
      -- ON CONFLICT (server_id, tool_name, coalesce(workspace_id, '')).
      CREATE TABLE mcp_tool_permissions (
        server_id TEXT NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
        tool_name TEXT NOT NULL,
        workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
        permission TEXT NOT NULL CHECK (permission IN ('allow', 'ask', 'deny')),
        updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE UNIQUE INDEX mcp_tool_permissions_by_target
        ON mcp_tool_permissions (server_id, tool_name, coalesce(workspace_id, ''));
      CREATE INDEX mcp_tool_permissions_by_workspace ON mcp_tool_permissions (workspace_id);

      CREATE TABLE mcp_tools_cache (
        server_id TEXT NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        description TEXT,
        input_schema_json TEXT NOT NULL CHECK (json_valid(input_schema_json)),
        annotations_json TEXT CHECK (json_valid(annotations_json)),
        fetched_at INTEGER NOT NULL,
        PRIMARY KEY (server_id, name)
      ) STRICT;

      -- pattern: a domain with an optional leading '*.' (subdomains). workspace_id NULL = global.
      CREATE TABLE web_policy_rules (
        id TEXT PRIMARY KEY NOT NULL,
        workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
        pattern TEXT NOT NULL CHECK (pattern <> ''),
        action TEXT NOT NULL CHECK (action IN ('allow', 'ask', 'deny')),
        preset TEXT,
        created_at INTEGER NOT NULL
      ) STRICT;
      CREATE UNIQUE INDEX web_policy_rules_by_pattern
        ON web_policy_rules (coalesce(workspace_id, ''), pattern);

      -- url_hash: sha256 hex of the normalized URL.
      CREATE TABLE web_cache (
        url_hash TEXT PRIMARY KEY NOT NULL,
        url TEXT NOT NULL,
        title TEXT,
        markdown TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        fetched_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX web_cache_by_expires_at ON web_cache (expires_at);
    `,
  },
  {
    // Companion signals and suggestions (N2), memory (C3) and model routing profiles (Mo1).
    version: 5,
    name: "companion",
    sql: `
      -- A signal is a recorded fact (evidence_json: output excerpt, path…); source_ref points to
      -- what produced it (tool call, process, test run).
      CREATE TABLE signals (
        id TEXT PRIMARY KEY NOT NULL,
        workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
        mission_id TEXT REFERENCES missions(id) ON DELETE SET NULL,
        kind TEXT NOT NULL CHECK (kind IN ('test_failed', 'process_crashed', 'mission_waiting',
          'mission_done', 'mission_failed', 'budget_reached', 'approval_pending')),
        source_ref TEXT NOT NULL,
        evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json)),
        state TEXT NOT NULL CHECK (state IN ('new', 'seen', 'ignored')),
        created_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX signals_by_state ON signals (state, created_at);
      CREATE INDEX signals_by_workspace ON signals (workspace_id, created_at);
      CREATE INDEX signals_by_mission ON signals (mission_id);

      -- Every suggestion references the signal that justifies it (no suggestion without a signal).
      CREATE TABLE suggestions (
        id TEXT PRIMARY KEY NOT NULL,
        signal_id TEXT NOT NULL REFERENCES signals(id) ON DELETE CASCADE,
        text TEXT NOT NULL,
        action_json TEXT CHECK (json_valid(action_json)),
        status TEXT NOT NULL CHECK (status IN ('proposed', 'accepted', 'dismissed', 'snoozed')),
        created_at INTEGER NOT NULL,
        decided_at INTEGER
      ) STRICT;
      CREATE INDEX suggestions_by_signal ON suggestions (signal_id);
      CREATE INDEX suggestions_by_status ON suggestions (status, created_at);

      CREATE TABLE memory_items (
        id TEXT PRIMARY KEY NOT NULL,
        workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
        scope TEXT NOT NULL CHECK (scope IN ('project', 'global')),
        content TEXT NOT NULL,
        provenance_json TEXT NOT NULL CHECK (json_valid(provenance_json)),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        CHECK ((scope = 'project') = (workspace_id IS NOT NULL))
      ) STRICT;
      CREATE INDEX memory_items_by_workspace ON memory_items (workspace_id, updated_at DESC);

      CREATE TABLE routing_profiles (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL UNIQUE,
        rules_json TEXT NOT NULL CHECK (json_valid(rules_json)),
        is_default INTEGER NOT NULL CHECK (is_default IN (0, 1)),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
      -- At most one default profile.
      CREATE UNIQUE INDEX routing_profiles_single_default ON routing_profiles (is_default)
        WHERE is_default = 1;
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
