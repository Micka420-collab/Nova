// ModelProvider contract: product-independent access to a model provider.
// Secrets are passed per call; providers never store keys.
import type {
  KeyCheckResult,
  ModelInfo,
  ProviderErrorInfo,
  ProviderId,
  UsageSummary,
} from "@nova/shared";

/** A tool call as sent back in an assistant message (OpenAI format on the wire). */
export interface ChatToolCall {
  /** Provider `tool_call_id`, echoed by the matching `tool` message. */
  id: string;
  name: string;
  /** Raw JSON arguments exactly as the model produced them. */
  arguments: string;
}

/**
 * Messages sent to the provider. An assistant turn that requested tools must carry its
 * `toolCalls` (and its opaque `reasoningDetails` when the provider returned some: several
 * providers reject a tool round-trip without them); each call is answered by one `tool` message.
 */
export type ChatMessageInput =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ChatToolCall[]; reasoningDetails?: unknown[] }
  | { role: "tool"; toolCallId: string; content: string };

/** A function tool offered to the model (`tools[].function`). */
export interface ProviderToolDefinition {
  name: string;
  description: string;
  /** JSON Schema of the arguments object. */
  parameters: Record<string, unknown>;
}

export type ToolChoice = "auto" | "none" | "required" | { name: string };

/** OpenRouter `web` plugin options (citations come back as `url_citation` annotations). */
export interface WebPluginOptions {
  maxResults?: number;
  includeDomains?: string[];
  excludeDomains?: string[];
}

export interface StreamChatRequest {
  modelId: string;
  messages: ChatMessageInput[];
  /** Aborting cancels the HTTP stream (and provider billing where the provider supports it). */
  signal: AbortSignal;
  /** OpenRouter `provider.data_collection`. */
  dataCollection: "deny" | "allow";
  maxTokens?: number;
  /** Function tools; OpenRouter requires them on EVERY request of a tool conversation. */
  tools?: ProviderToolDefinition[];
  toolChoice?: ToolChoice;
  parallelToolCalls?: boolean;
  /** Enables the OpenRouter web plugin for this request. */
  webPlugin?: WebPluginOptions;
  /**
   * Mo2: models tried after `modelId`, in order (OpenRouter `models`). The billed and served model
   * is reported by `meta.servedModel`; callers compare it with `modelId` to signal a fallback.
   */
  fallbackModelIds?: string[];
  /**
   * Emit `reasoning_details` events (opaque blocks to echo back in tool round-trips). Off by
   * default: plain chat never needs them and they carry reasoning text (ADR-008).
   */
  keepReasoningDetails?: boolean;
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
  /**
   * Fragment of a tool call: `index` identifies the call within the turn; `id` and `name` arrive
   * (usually once) with the first fragment; `argumentsDelta` pieces concatenate into the JSON.
   */
  | { type: "tool_call_delta"; index: number; id: string | null; name: string | null; argumentsDelta: string }
  /**
   * Opaque reasoning blocks to send back with the assistant message (never displayed, never
   * stored: ADR-008). Only with `keepReasoningDetails`; pieces merge with `mergeReasoningDetails`.
   */
  | { type: "reasoning_details"; details: unknown[] }
  /** Web plugin citation (`url_citation` annotation). Untrusted content. */
  | { type: "citation"; url: string; title: string | null; snippet: string | null }
  /** `tool_calls` when the turn ends by requesting tools. */
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
