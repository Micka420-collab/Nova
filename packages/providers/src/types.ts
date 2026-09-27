// ModelProvider contract: product-independent access to a model provider.
// Secrets are passed per call; providers never store keys.
import type {
  KeyCheckResult,
  ModelInfo,
  ProviderErrorInfo,
  ProviderId,
  UsageSummary,
} from "@nova/shared";

export interface ChatMessageInput {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface StreamChatRequest {
  modelId: string;
  messages: ChatMessageInput[];
  /** Aborting cancels the HTTP stream (and provider billing where the provider supports it). */
  signal: AbortSignal;
  /** OpenRouter `provider.data_collection`. */
  dataCollection: "deny" | "allow";
  maxTokens?: number;
}

/**
 * Normalized streaming events. Reasoning content is intentionally not exposed:
 * only the fact that the model is reasoning is reported.
 */
export type ProviderStreamEvent =
  | { type: "meta"; servedModel: string | null; servedProvider: string | null; generationId: string | null }
  | { type: "reasoning" }
  | { type: "text"; text: string }
  | { type: "usage"; usage: UsageSummary }
  | { type: "finish"; finishReason: string | null };

export interface ModelProvider {
  readonly id: ProviderId;
  /** Fetch the live catalog. Never returns hard-coded model ids. */
  listModels(options?: { apiKey?: string; signal?: AbortSignal }): Promise<ModelInfo[]>;
  /** Validate a key and read its limits (OpenRouter: GET /api/v1/key). */
  checkKey(apiKey: string, options?: { signal?: AbortSignal }): Promise<KeyCheckResult>;
  /**
   * Stream a chat completion. Throws `ProviderError` for HTTP errors, mid-stream error chunks,
   * timeouts, network failures, interrupted streams and aborts (code `aborted`).
   */
  streamChat(apiKey: string, request: StreamChatRequest): AsyncIterable<ProviderStreamEvent>;
}

export class ProviderError extends Error {
  readonly info: ProviderErrorInfo;
  constructor(info: ProviderErrorInfo, message?: string) {
    super(message ?? info.providerMessage ?? info.code);
    this.name = "ProviderError";
    this.info = info;
  }
}

export interface ProviderTimeouts {
  /** Max wait for response headers. */
  requestMs: number;
  /** Max silence between two received chunks (keep-alive comments count as activity). */
  idleMs: number;
}

export const DEFAULT_TIMEOUTS: ProviderTimeouts = { requestMs: 30_000, idleMs: 120_000 };
