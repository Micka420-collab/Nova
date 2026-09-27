// NovaStore implementation on node:sqlite.
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import {
  DEFAULT_SETTINGS,
  SettingsPatchSchema,
  type AppSettings,
  type Conversation,
  type ConversationSummary,
  type KeyCheckResult,
  type KeyStorage,
  type Message,
  type MessageRole,
  type MessageStatus,
  type ModelInfo,
  type ProviderErrorInfo,
  type ProviderId,
  type SettingsPatch,
  type UsageSummary,
  type UsageTotals,
} from "@nova/shared";
import { migrate } from "./migrations";
import {
  jsonOrNull,
  readBlob,
  readJsonOrNull,
  readNumber,
  readNumberOrNull,
  readText,
  readTextOrNull,
  withTransaction,
  type Row,
} from "./sqlite";
import type {
  MessagePatch,
  NewMessage,
  NovaStore,
  ProviderConnectionRecord,
  SecretRecord,
  UsageRecordInput,
} from "./types";

export interface NovaStoreOptions {
  /** Clock used for every stored timestamp (tests inject a fake one). */
  now?: () => number;
}

const MEMORY = ":memory:";
const DEFAULT_LIST_LIMIT = 200;
const PREVIEW_MAX_CHARS = 120;
const SETTINGS_KEYS = ["theme", "defaultModelId", "companion", "privacy"] as const;

/** Opens (creating if needed) and migrates the NOVA database. Refuses a newer schema. */
export function openNovaStore(path: string, options: NovaStoreOptions = {}): NovaStore {
  const location = path === MEMORY ? MEMORY : resolve(path);
  const db = new DatabaseSync(location);
  try {
    db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    // Migrate (and refuse a newer schema) before any other write to the file.
    migrate(db);
    if (location !== MEMORY) db.exec("PRAGMA journal_mode = WAL");
    // SQLite LIKE/lower() only fold ASCII; search must be case-insensitive for "É" too.
    db.function("nova_casefold", { deterministic: true }, (value) =>
      typeof value === "string" ? value.toLowerCase() : null,
    );
  } catch (error) {
    db.close();
    throw error;
  }
  return new SqliteNovaStore(db, location, options.now ?? Date.now);
}

function applySettingsPatch(settings: AppSettings, patch: SettingsPatch): AppSettings {
  return {
    theme: patch.theme ?? settings.theme,
    defaultModelId: patch.defaultModelId === undefined ? settings.defaultModelId : patch.defaultModelId,
    companion: {
      visible: patch.companion?.visible ?? settings.companion.visible,
      motion: patch.companion?.motion ?? settings.companion.motion,
    },
    privacy: {
      providerDataCollection:
        patch.privacy?.providerDataCollection ?? settings.privacy.providerDataCollection,
    },
  };
}

function toPreview(content: string | null): string | null {
  if (content === null) return null;
  const collapsed = content.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) return null;
  const chars = Array.from(collapsed);
  return chars.length > PREVIEW_MAX_CHARS
    ? `${chars.slice(0, PREVIEW_MAX_CHARS).join("").trimEnd()}…`
    : collapsed;
}

function toConversation(row: Row): Conversation {
  return {
    id: readText(row, "id"),
    title: readText(row, "title"),
    modelId: readTextOrNull(row, "model_id"),
    createdAt: readNumber(row, "created_at"),
    updatedAt: readNumber(row, "updated_at"),
  };
}

function toMessage(row: Row): Message {
  return {
    id: readText(row, "id"),
    conversationId: readText(row, "conversation_id"),
    // Enum columns are guarded by CHECK constraints.
    role: readText(row, "role") as MessageRole,
    content: readText(row, "content"),
    status: readText(row, "status") as MessageStatus,
    modelId: readTextOrNull(row, "model_id"),
    servedModel: readTextOrNull(row, "served_model"),
    servedProvider: readTextOrNull(row, "served_provider"),
    error: readJsonOrNull<ProviderErrorInfo>(row, "error_json"),
    usage: readJsonOrNull<UsageSummary>(row, "usage_json"),
    createdAt: readNumber(row, "created_at"),
    updatedAt: readNumber(row, "updated_at"),
  };
}

class SqliteNovaStore implements NovaStore {
  constructor(
    private readonly db: DatabaseSync,
    readonly path: string,
    private readonly now: () => number,
  ) {}

  close(): void {
    if (this.db.isOpen) this.db.close();
  }

  // -------------------------------------------------------------------------
  // Settings: one row per top-level key, merged over DEFAULT_SETTINGS on read so that
  // fields missing from a stored group keep their default.

  getSettings(): AppSettings {
    let stored: SettingsPatch = {};
    for (const row of this.db.prepare("SELECT key, value FROM settings").all()) {
      let value: unknown;
      try {
        value = JSON.parse(readText(row, "value"));
      } catch {
        continue;
      }
      // Unknown keys and invalid values are ignored: the default applies.
      const parsed = SettingsPatchSchema.safeParse({ [readText(row, "key")]: value });
      if (parsed.success) stored = { ...stored, ...parsed.data };
    }
    return applySettingsPatch(DEFAULT_SETTINGS, stored);
  }

  updateSettings(patch: SettingsPatch): AppSettings {
    return withTransaction(this.db, () => {
      const next = applySettingsPatch(this.getSettings(), patch);
      const upsert = this.db.prepare(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      );
      for (const key of SETTINGS_KEYS) {
        if (patch[key] !== undefined) upsert.run(key, JSON.stringify(next[key]));
      }
      return next;
    });
  }

  // -------------------------------------------------------------------------
  // Secrets (ciphertext only)

  putSecret(record: SecretRecord): void {
    // Upsert instead of REPLACE: REPLACE deletes the row, which would null `secret_ref`.
    this.db
      .prepare(
        `INSERT INTO secrets (id, ciphertext, backend, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           ciphertext = excluded.ciphertext, backend = excluded.backend, created_at = excluded.created_at`,
      )
      .run(record.id, record.ciphertext, record.backend, record.createdAt);
  }

  getSecret(id: string): SecretRecord | null {
    const row = this.db.prepare("SELECT * FROM secrets WHERE id = ?").get(id);
    if (!row) return null;
    return {
      id: readText(row, "id"),
      ciphertext: readBlob(row, "ciphertext"),
      backend: readText(row, "backend"),
      createdAt: readNumber(row, "created_at"),
    };
  }

  deleteSecret(id: string): void {
    this.db.prepare("DELETE FROM secrets WHERE id = ?").run(id);
  }

  // -------------------------------------------------------------------------
  // Provider connections

  getConnection(providerId: ProviderId): ProviderConnectionRecord | null {
    const row = this.db
      .prepare("SELECT * FROM provider_connections WHERE provider_id = ?")
      .get(providerId);
    if (!row) return null;
    return {
      providerId,
      secretRef: readTextOrNull(row, "secret_ref"),
      storage: readText(row, "storage") as KeyStorage,
      keyHint: readText(row, "key_hint"),
      state: readText(row, "state") as ProviderConnectionRecord["state"],
      lastCheckedAt: readNumberOrNull(row, "last_checked_at"),
      lastError: readJsonOrNull<ProviderErrorInfo>(row, "last_error"),
      check: readJsonOrNull<KeyCheckResult>(row, "check_json"),
      updatedAt: readNumber(row, "updated_at"),
    };
  }

  upsertConnection(record: ProviderConnectionRecord): void {
    this.db
      .prepare(
        `INSERT INTO provider_connections (provider_id, secret_ref, storage, key_hint, state,
           last_checked_at, last_error, check_json, updated_at)
         VALUES (:providerId, :secretRef, :storage, :keyHint, :state,
           :lastCheckedAt, :lastError, :check, :updatedAt)
         ON CONFLICT (provider_id) DO UPDATE SET
           secret_ref = excluded.secret_ref, storage = excluded.storage,
           key_hint = excluded.key_hint, state = excluded.state,
           last_checked_at = excluded.last_checked_at, last_error = excluded.last_error,
           check_json = excluded.check_json, updated_at = excluded.updated_at`,
      )
      .run({
        providerId: record.providerId,
        secretRef: record.secretRef,
        storage: record.storage,
        keyHint: record.keyHint,
        state: record.state,
        lastCheckedAt: record.lastCheckedAt,
        lastError: jsonOrNull(record.lastError),
        check: jsonOrNull(record.check),
        updatedAt: record.updatedAt,
      });
  }

  deleteConnection(providerId: ProviderId): void {
    this.db.prepare("DELETE FROM provider_connections WHERE provider_id = ?").run(providerId);
  }

  // -------------------------------------------------------------------------
  // Model catalog cache

  saveCatalog(providerId: ProviderId, models: ModelInfo[], fetchedAt: number): void {
    this.db
      .prepare(
        `INSERT INTO model_catalog (provider_id, fetched_at, models_json) VALUES (?, ?, ?)
         ON CONFLICT (provider_id) DO UPDATE SET
           fetched_at = excluded.fetched_at, models_json = excluded.models_json`,
      )
      .run(providerId, fetchedAt, JSON.stringify(models));
  }

  loadCatalog(providerId: ProviderId): { models: ModelInfo[]; fetchedAt: number } | null {
    const row = this.db.prepare("SELECT * FROM model_catalog WHERE provider_id = ?").get(providerId);
    if (!row) return null;
    return {
      models: JSON.parse(readText(row, "models_json")) as ModelInfo[],
      fetchedAt: readNumber(row, "fetched_at"),
    };
  }

  // -------------------------------------------------------------------------
  // Conversations

  createConversation(input: { title: string; modelId: string | null }): Conversation {
    const now = this.now();
    const conversation: Conversation = {
      id: randomUUID(),
      title: input.title,
      modelId: input.modelId,
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        "INSERT INTO conversations (id, title, model_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(conversation.id, conversation.title, conversation.modelId, now, now);
    return conversation;
  }

  getConversation(id: string): Conversation | null {
    const row = this.db.prepare("SELECT * FROM conversations WHERE id = ?").get(id);
    return row ? toConversation(row) : null;
  }

  /**
   * `query` is matched literally (no wildcards) and case-insensitively, Unicode included,
   * against titles and message contents. Ties on `updatedAt` keep the newest insert first.
   */
  listConversations(options: { query?: string; limit?: number } = {}): ConversationSummary[] {
    const query = options.query?.trim() ?? "";
    const rows = this.db
      .prepare(
        `SELECT c.*,
           (SELECT count(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count,
           (SELECT m.content FROM messages m
              WHERE m.conversation_id = c.id AND trim(m.content, ' ' || char(9, 10, 13)) <> ''
              ORDER BY m.seq DESC LIMIT 1) AS last_content
         FROM conversations c
         WHERE :needle IS NULL
           OR instr(nova_casefold(c.title), :needle) > 0
           OR EXISTS (SELECT 1 FROM messages m
                        WHERE m.conversation_id = c.id AND instr(nova_casefold(m.content), :needle) > 0)
         ORDER BY c.updated_at DESC, c.rowid DESC
         LIMIT :limit`,
      )
      .all({
        needle: query === "" ? null : query.toLowerCase(),
        limit: options.limit ?? DEFAULT_LIST_LIMIT,
      });
    return rows.map((row) => ({
      ...toConversation(row),
      messageCount: readNumber(row, "message_count"),
      preview: toPreview(readTextOrNull(row, "last_content")),
    }));
  }

  /** Renaming does not bump `updatedAt`: list order reflects conversation activity. */
  renameConversation(id: string, title: string): Conversation | null {
    this.db.prepare("UPDATE conversations SET title = ? WHERE id = ?").run(title, id);
    return this.getConversation(id);
  }

  touchConversation(id: string, modelId: string | null): void {
    this.db
      .prepare("UPDATE conversations SET model_id = ?, updated_at = ? WHERE id = ?")
      .run(modelId, this.now(), id);
  }

  deleteConversation(id: string): boolean {
    const result = this.db.prepare("DELETE FROM conversations WHERE id = ?").run(id);
    return Number(result.changes) > 0;
  }

  // -------------------------------------------------------------------------
  // Messages

  insertMessage(input: NewMessage): Message {
    const id = randomUUID();
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO messages
           (id, conversation_id, seq, role, content, status, model_id, created_at, updated_at)
         VALUES (:id, :conversationId,
           (SELECT coalesce(max(seq), 0) + 1 FROM messages WHERE conversation_id = :conversationId),
           :role, :content, :status, :modelId, :now, :now)`,
      )
      .run({
        id,
        conversationId: input.conversationId,
        role: input.role,
        content: input.content,
        status: input.status,
        modelId: input.modelId,
        now,
      });
    const message = this.getMessage(id);
    if (!message) throw new Error("Inserted message not found");
    return message;
  }

  updateMessage(id: string, patch: MessagePatch): Message | null {
    const columns: Record<string, SQLInputValue> = { updated_at: this.now() };
    if (patch.content !== undefined) columns["content"] = patch.content;
    if (patch.status !== undefined) columns["status"] = patch.status;
    if (patch.servedModel !== undefined) columns["served_model"] = patch.servedModel;
    if (patch.servedProvider !== undefined) columns["served_provider"] = patch.servedProvider;
    if (patch.error !== undefined) columns["error_json"] = jsonOrNull(patch.error);
    if (patch.usage !== undefined) columns["usage_json"] = jsonOrNull(patch.usage);
    // Column names come from the fixed list above, never from input.
    const assignments = Object.keys(columns)
      .map((column) => `${column} = :${column}`)
      .join(", ");
    this.db.prepare(`UPDATE messages SET ${assignments} WHERE id = :id`).run({ ...columns, id });
    return this.getMessage(id);
  }

  getMessage(id: string): Message | null {
    const row = this.db.prepare("SELECT * FROM messages WHERE id = ?").get(id);
    return row ? toMessage(row) : null;
  }

  listMessages(conversationId: string): Message[] {
    return this.db
      .prepare("SELECT * FROM messages WHERE conversation_id = ? ORDER BY seq")
      .all(conversationId)
      .map(toMessage);
  }

  deleteMessage(id: string): boolean {
    const result = this.db.prepare("DELETE FROM messages WHERE id = ?").run(id);
    return Number(result.changes) > 0;
  }

  // -------------------------------------------------------------------------
  // Usage

  recordUsage(input: UsageRecordInput): void {
    const { usage } = input;
    this.db
      .prepare(
        `INSERT INTO usage_records
           (id, conversation_id, message_id, provider_id, model_id, served_model, served_provider,
            prompt_tokens, completion_tokens, reasoning_tokens, cached_tokens, cost, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        input.conversationId,
        input.messageId,
        input.providerId,
        input.modelId,
        input.servedModel,
        input.servedProvider,
        usage.promptTokens,
        usage.completionTokens,
        usage.reasoningTokens,
        usage.cachedTokens,
        usage.cost,
        this.now(),
      );
  }

  /**
   * Sums every usage record of the conversation (unreported token counts and costs count as 0).
   * `messagesWithUnknownCost` counts the assistant messages that may have been billed (complete,
   * stopped or interrupted, or failed after text arrived) but have no usage record carrying a cost,
   * so `cost` is then only a lower bound. A failure before any text (e.g. HTTP 402/429) is not billed.
   */
  conversationUsage(conversationId: string): UsageTotals {
    const totals = this.db
      .prepare(
        `SELECT coalesce(sum(prompt_tokens), 0) AS prompt_tokens,
                coalesce(sum(completion_tokens), 0) AS completion_tokens,
                coalesce(sum(cost), 0) AS cost
         FROM usage_records WHERE conversation_id = ?`,
      )
      .get(conversationId);
    const unknown = this.db
      .prepare(
        `SELECT count(*) AS n FROM messages m
         WHERE m.conversation_id = ? AND m.role = 'assistant'
           AND (m.status IN ('complete', 'stopped', 'interrupted') OR (m.status = 'error' AND m.content <> ''))
           AND NOT EXISTS (SELECT 1 FROM usage_records u WHERE u.message_id = m.id AND u.cost IS NOT NULL)`,
      )
      .get(conversationId);
    if (!totals || !unknown) throw new Error("Aggregate query returned no row");
    return {
      promptTokens: readNumber(totals, "prompt_tokens"),
      completionTokens: readNumber(totals, "completion_tokens"),
      cost: readNumber(totals, "cost"),
      messagesWithUnknownCost: readNumber(unknown, "n"),
    };
  }

  markInterruptedStreams(): number {
    const result = this.db
      .prepare("UPDATE messages SET status = 'interrupted', updated_at = ? WHERE status = 'streaming'")
      .run(this.now());
    return Number(result.changes);
  }
}
