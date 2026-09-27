// NovaStore contract: local product state in SQLite (node:sqlite). Project files are never stored here.
import type {
  AppSettings,
  Conversation,
  ConversationSummary,
  KeyCheckResult,
  KeyStorage,
  Message,
  MessageRole,
  MessageStatus,
  ModelInfo,
  ProviderErrorInfo,
  ProviderId,
  SettingsPatch,
  UsageSummary,
  UsageTotals,
} from "@nova/shared";

export interface SecretRecord {
  id: string;
  /** Ciphertext produced by the vault; never plaintext. */
  ciphertext: Uint8Array;
  /** Vault backend that produced the ciphertext (e.g. `gnome_libsecret`, `basic_text`, `dpapi`). */
  backend: string;
  createdAt: number;
}

export interface ProviderConnectionRecord {
  providerId: ProviderId;
  /** Reference to `secrets.id`; null for session-only keys (kept in memory by main). */
  secretRef: string | null;
  storage: KeyStorage;
  keyHint: string;
  state: "unverified" | "valid" | "invalid" | "error";
  lastCheckedAt: number | null;
  lastError: ProviderErrorInfo | null;
  check: KeyCheckResult | null;
  updatedAt: number;
}

export interface NewMessage {
  conversationId: string;
  role: MessageRole;
  content: string;
  status: MessageStatus;
  modelId: string | null;
}

export interface MessagePatch {
  content?: string;
  status?: MessageStatus;
  servedModel?: string | null;
  servedProvider?: string | null;
  error?: ProviderErrorInfo | null;
  usage?: UsageSummary | null;
}

export interface UsageRecordInput {
  conversationId: string;
  messageId: string;
  providerId: ProviderId;
  modelId: string;
  servedModel: string | null;
  servedProvider: string | null;
  usage: UsageSummary;
}

export interface NovaStore {
  /** Absolute path of the database file (or `:memory:`). */
  readonly path: string;
  close(): void;

  getSettings(): AppSettings;
  updateSettings(patch: SettingsPatch): AppSettings;

  putSecret(record: SecretRecord): void;
  getSecret(id: string): SecretRecord | null;
  deleteSecret(id: string): void;

  getConnection(providerId: ProviderId): ProviderConnectionRecord | null;
  upsertConnection(record: ProviderConnectionRecord): void;
  deleteConnection(providerId: ProviderId): void;

  saveCatalog(providerId: ProviderId, models: ModelInfo[], fetchedAt: number): void;
  loadCatalog(providerId: ProviderId): { models: ModelInfo[]; fetchedAt: number } | null;

  createConversation(input: { title: string; modelId: string | null }): Conversation;
  getConversation(id: string): Conversation | null;
  /** Most recently updated first. `query` matches titles and message contents (case-insensitive). */
  listConversations(options?: { query?: string; limit?: number }): ConversationSummary[];
  renameConversation(id: string, title: string): Conversation | null;
  /** Sets `modelId` and bumps `updatedAt`. */
  touchConversation(id: string, modelId: string | null): void;
  /** Deletes the conversation with its messages and usage records. Returns false if absent. */
  deleteConversation(id: string): boolean;

  insertMessage(input: NewMessage): Message;
  updateMessage(id: string, patch: MessagePatch): Message | null;
  getMessage(id: string): Message | null;
  /** Chronological order. */
  listMessages(conversationId: string): Message[];
  deleteMessage(id: string): boolean;

  recordUsage(input: UsageRecordInput): void;
  conversationUsage(conversationId: string): UsageTotals;

  /**
   * Startup recovery: messages left in `streaming` by a previous process become `interrupted`
   * (the provider-side result is uncertain). Returns the number of messages changed.
   */
  markInterruptedStreams(): number;
}
