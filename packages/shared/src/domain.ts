// Domain types shared by the desktop main process, the runtime packages and the renderer.
// Timestamps are epoch milliseconds. Unknown values are `null`, never guessed.

export type ProviderId = "openrouter";

export type MessageRole = "user" | "assistant";

/**
 * Lifecycle of a stored message.
 * - `streaming`: generation in progress (only valid while the app runs).
 * - `interrupted`: the app stopped while streaming; the provider-side outcome is uncertain.
 */
export type MessageStatus = "complete" | "streaming" | "stopped" | "error" | "interrupted";

export interface UsageSummary {
  promptTokens: number | null;
  completionTokens: number | null;
  reasoningTokens: number | null;
  cachedTokens: number | null;
  /** Cost reported by the provider for this generation, in provider credits (OpenRouter: USD credits). */
  cost: number | null;
}

export interface Conversation {
  id: string;
  title: string;
  /** Last model chosen in this conversation. */
  modelId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ConversationSummary extends Conversation {
  messageCount: number;
  /** First characters of the last message, for the sidebar. */
  preview: string | null;
}

export interface Message {
  id: string;
  conversationId: string;
  role: MessageRole;
  content: string;
  status: MessageStatus;
  /** Model requested by NOVA. */
  modelId: string | null;
  /** Model and upstream provider reported by the provider in the response, when present. */
  servedModel: string | null;
  servedProvider: string | null;
  error: ProviderErrorInfo | null;
  usage: UsageSummary | null;
  createdAt: number;
  updatedAt: number;
}

export interface UsageTotals {
  promptTokens: number;
  completionTokens: number;
  /** Sum of reported costs. */
  cost: number;
  /** Assistant messages whose cost was not reported (so `cost` is a lower bound). */
  messagesWithUnknownCost: number;
}

export interface ConversationPage {
  /** Most recently updated first. */
  items: ConversationSummary[];
  /** More (older) conversations exist beyond `items`; search reaches them. */
  hasMore: boolean;
}

export interface ConversationDetail {
  conversation: Conversation;
  messages: Message[];
  usage: UsageTotals;
}

// ---------------------------------------------------------------------------
// Provider errors

export type ProviderErrorCode =
  | "no_key"
  | "invalid_key"
  | "insufficient_credits"
  | "forbidden"
  | "rate_limited"
  | "timeout"
  | "not_found"
  | "model_unavailable"
  | "no_provider"
  | "bad_request"
  | "network"
  | "stream_interrupted"
  | "provider_error"
  | "aborted"
  /** The model stopped at its output token limit (finish_reason "length"); partial text kept. */
  | "truncated"
  /** The provider's content filter ended the answer (finish_reason "content_filter"). */
  | "filtered"
  /** The stream completed without any answer text. */
  | "empty_response"
  /** A stored key exists but cannot be decrypted (keyring locked, changed or reset). */
  | "key_unreadable"
  | "unknown";

export interface ProviderErrorInfo {
  code: ProviderErrorCode;
  httpStatus: number | null;
  /** Seconds suggested by the provider before retrying (Retry-After), when known. */
  retryAfterSec: number | null;
  /** Provider message, secrets redacted and truncated. Displayed as detail only. */
  providerMessage: string | null;
  /** Whether retrying the same request later can reasonably succeed. */
  retryable: boolean;
}

// ---------------------------------------------------------------------------
// Model catalog

export interface ModelPricing {
  /** USD per million prompt tokens; null when unknown. */
  promptPerMTok: number | null;
  /** USD per million completion tokens; null when unknown. */
  completionPerMTok: number | null;
  /** True when the provider marks the price as variable (e.g. routers). */
  variable: boolean;
}

export interface ModelInfo {
  id: string;
  name: string;
  /** Author/organisation prefix of the id (e.g. `deepseek`). */
  author: string;
  description: string | null;
  contextLength: number | null;
  maxCompletionTokens: number | null;
  inputModalities: string[] | null;
  outputModalities: string[] | null;
  /** `null` when the catalog does not say. */
  supportsTools: boolean | null;
  supportsStructuredOutputs: boolean | null;
  supportsReasoning: boolean | null;
  pricing: ModelPricing;
  isFree: boolean;
  /** ISO date after which the provider retires the model, when announced. */
  expirationDate: string | null;
  createdAt: number | null;
}

export interface ModelCatalog {
  providerId: ProviderId;
  models: ModelInfo[];
  fetchedAt: number;
  source: "network" | "cache";
  /** Set when a refresh failed and a cached copy is served instead. */
  refreshError: ProviderErrorInfo | null;
}

// ---------------------------------------------------------------------------
// Secrets and provider connections

/**
 * Strength of the local secret vault.
 * - `os`: OS keychain / DPAPI / libsecret / kwallet.
 * - `weak`: Electron fallback with a hard-coded key (Linux without a keyring). Obfuscation only.
 * - `unavailable`: encryption not available at all.
 */
export type VaultLevel = "os" | "weak" | "unavailable";

export interface VaultStatus {
  level: VaultLevel;
  /** Backend name reported by the platform (e.g. `gnome_libsecret`, `basic_text`, `dpapi`, `keychain`). */
  backend: string;
}

export type KeyStorage = "vault" | "weak-vault" | "session";

export interface KeyCheckResult {
  label: string | null;
  /** Credit limit of the key; null = unlimited or unknown. */
  limit: number | null;
  limitRemaining: number | null;
  usage: number | null;
  isFreeTier: boolean | null;
}

export type ConnectionState = "absent" | "unverified" | "valid" | "invalid" | "error";

export interface ProviderConnectionView {
  providerId: ProviderId;
  state: ConnectionState;
  storage: KeyStorage | null;
  /** Last 4 characters of the key, never more. */
  keyHint: string | null;
  lastCheckedAt: number | null;
  lastError: ProviderErrorInfo | null;
  check: KeyCheckResult | null;
}

// ---------------------------------------------------------------------------
// Settings

export type ThemePreference = "system" | "dark" | "light";
export type MotionPreference = "system" | "reduce" | "full";

export interface AppSettings {
  theme: ThemePreference;
  defaultModelId: string | null;
  companion: {
    visible: boolean;
    motion: MotionPreference;
  };
  privacy: {
    /** OpenRouter `provider.data_collection`: `deny` routes only to providers that do not retain/train on prompts. */
    providerDataCollection: "deny" | "allow";
  };
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: "system",
  defaultModelId: null,
  companion: { visible: true, motion: "system" },
  privacy: { providerDataCollection: "deny" },
};

export interface AppInfo {
  version: string;
  platform: string;
  arch: string;
  isPackaged: boolean;
  electronVersion: string;
  dataDir: string;
  logDir: string;
  vault: VaultStatus;
}
