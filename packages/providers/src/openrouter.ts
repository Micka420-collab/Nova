// OpenRouter adapter of the ModelProvider contract (catalog, key check, streaming chat).
import {
  sanitizeProviderMessage,
  type KeyCheckResult,
  type ModelInfo,
  type ProviderId,
  type UsageSummary,
} from "@nova/shared";
import { normalizeOpenRouterModel } from "./catalog";
import { asCount, asFiniteNumber, asRecord, asString, type JsonRecord } from "./coerce";
import { mapHttpError, mapStreamError, providerErrorInfo } from "./errors";
import { readChunks, readSse } from "./sse";
import {
  DEFAULT_TIMEOUTS,
  ProviderError,
  type ModelProvider,
  type ProviderStreamEvent,
  type ProviderTimeouts,
  type StreamChatRequest,
} from "./types";

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_APP_URL = "https://github.com/Micka420-collab/Nova";
const DEFAULT_APP_TITLE = "NOVA";
const SECRET_MASK = "[secret masqué]";

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface OpenRouterProviderOptions {
  baseUrl?: string;
  fetch?: FetchLike;
  /** App attribution sent as `HTTP-Referer` and `X-OpenRouter-Title`. */
  appUrl?: string;
  appTitle?: string;
  timeouts?: Partial<ProviderTimeouts>;
}

type AbortCause = "user" | "request_timeout" | "idle_timeout";

/** Removes the literal key whatever its shape (`redactSecrets` only knows common key formats). */
function scrub(text: string, secret: string | undefined): string {
  return secret ? text.split(secret).join(SECRET_MASK) : text;
}

function describeFailure(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  return error.cause instanceof Error ? `${error.message}: ${error.cause.message}` : error.message;
}

function invalidResponse(what: string): ProviderError {
  return new ProviderError(providerErrorInfo("provider_error"), `invalid ${what} response`);
}

function parseJsonRecord(text: string): JsonRecord | null {
  try {
    return asRecord(JSON.parse(text));
  } catch {
    return null;
  }
}

/** One call's cancellation: the user signal and the (single) timer abort the same controller. */
class CallScope {
  private readonly controller = new AbortController();
  cause: AbortCause | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private timeoutMs = 0;
  private readonly userSignal: AbortSignal | undefined;
  private readonly onUserAbort = (): void => this.abort("user");

  constructor(userSignal: AbortSignal | undefined) {
    this.userSignal = userSignal;
    if (userSignal?.aborted) this.abort("user");
    else userSignal?.addEventListener("abort", this.onUserAbort, { once: true });
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** (Re)starts the timer; when it fires the call is aborted with `cause`. */
  arm(ms: number, cause: "request_timeout" | "idle_timeout"): void {
    clearTimeout(this.timer);
    this.timeoutMs = ms;
    this.timer = setTimeout(() => this.abort(cause), ms);
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.userSignal?.removeEventListener("abort", this.onUserAbort);
  }

  /**
   * Normalizes any failure. Already-mapped errors pass through; otherwise the abort cause wins over
   * the error it triggered (AbortError, cancelled read), and `fallback` covers the rest.
   */
  failure(error: unknown, fallback: "network" | "stream_interrupted", secret: string | undefined): ProviderError {
    if (error instanceof ProviderError) return error;
    switch (this.cause) {
      case "user":
        return new ProviderError(providerErrorInfo("aborted"), "request aborted");
      case "request_timeout":
        return new ProviderError(providerErrorInfo("timeout"), `no response within ${this.timeoutMs} ms`);
      case "idle_timeout":
        return new ProviderError(providerErrorInfo("timeout"), `no data received for ${this.timeoutMs} ms`);
      case null:
        break;
    }
    const detail = sanitizeProviderMessage(scrub(describeFailure(error), secret));
    return new ProviderError(providerErrorInfo(fallback, { providerMessage: detail }), detail ?? fallback);
  }

  private abort(cause: AbortCause): void {
    if (this.cause !== null) return;
    this.cause = cause;
    clearTimeout(this.timer);
    this.controller.abort();
  }
}

function normalizeUsage(value: unknown): UsageSummary | null {
  const usage = asRecord(value);
  if (!usage) return null;
  const cost = asFiniteNumber(usage.cost);
  return {
    promptTokens: asCount(usage.prompt_tokens),
    completionTokens: asCount(usage.completion_tokens),
    reasoningTokens: asCount(asRecord(usage.completion_tokens_details)?.reasoning_tokens),
    cachedTokens: asCount(asRecord(usage.prompt_tokens_details)?.cached_tokens),
    cost: cost !== null && cost >= 0 ? cost : null,
  };
}

interface StreamState {
  metaSent: boolean;
  /** Last finish_reason received; non-null means the generation finished. */
  finishReason: string | null;
}

/** Turns one SSE data payload into events. A chunk is atomic: it either throws or yields all its events. */
function interpretChunk(payload: string, state: StreamState): ProviderStreamEvent[] {
  const chunk = parseJsonRecord(payload);
  if (!chunk) throw invalidResponse("stream chunk");
  if (chunk.error !== undefined && chunk.error !== null) throw new ProviderError(mapStreamError(chunk.error));

  const events: ProviderStreamEvent[] = [];
  if (!state.metaSent) {
    state.metaSent = true;
    events.push({
      type: "meta",
      servedModel: asString(chunk.model),
      servedProvider: asString(chunk.provider),
      generationId: asString(chunk.id),
    });
  }
  const firstChoice: unknown = Array.isArray(chunk.choices) ? chunk.choices[0] : null;
  const choice = asRecord(firstChoice);
  const delta = asRecord(choice?.delta);
  const reasoning = delta?.reasoning;
  const reasoningDetails = delta?.reasoning_details;
  if (
    (typeof reasoning === "string" && reasoning.length > 0) ||
    (Array.isArray(reasoningDetails) && reasoningDetails.length > 0)
  ) {
    events.push({ type: "reasoning" });
  }
  const content = delta?.content;
  if (typeof content === "string" && content.length > 0) events.push({ type: "text", text: content });

  const finishReason = choice?.finish_reason;
  if (finishReason === "error") throw new ProviderError(providerErrorInfo("provider_error"), "generation ended with an error");
  if (typeof finishReason === "string") state.finishReason = finishReason;

  const usage = normalizeUsage(chunk.usage);
  if (usage) events.push({ type: "usage", usage });
  return events;
}

export class OpenRouterProvider implements ModelProvider {
  readonly id: ProviderId = "openrouter";
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly appUrl: string;
  private readonly appTitle: string;
  private readonly timeouts: ProviderTimeouts;

  constructor(options: OpenRouterProviderOptions = {}) {
    this.baseUrl = (options.baseUrl ?? OPENROUTER_BASE_URL).replace(/\/+$/, "");
    this.fetchImpl = options.fetch ?? ((url, init) => fetch(url, init));
    this.appUrl = options.appUrl ?? DEFAULT_APP_URL;
    this.appTitle = options.appTitle ?? DEFAULT_APP_TITLE;
    this.timeouts = {
      requestMs: options.timeouts?.requestMs ?? DEFAULT_TIMEOUTS.requestMs,
      idleMs: options.timeouts?.idleMs ?? DEFAULT_TIMEOUTS.idleMs,
    };
  }

  async listModels(options: { apiKey?: string; signal?: AbortSignal } = {}): Promise<ModelInfo[]> {
    const payload = await this.getJson("/models", options.apiKey, options.signal);
    if (!Array.isArray(payload.data)) throw invalidResponse("catalog");
    // Invalid entries are skipped; a duplicated id keeps its first occurrence.
    const models = new Map<string, ModelInfo>();
    for (const raw of payload.data) {
      const model = normalizeOpenRouterModel(raw);
      if (model && !models.has(model.id)) models.set(model.id, model);
    }
    return [...models.values()];
  }

  async checkKey(apiKey: string, options: { signal?: AbortSignal } = {}): Promise<KeyCheckResult> {
    const payload = await this.getJson("/key", apiKey, options.signal);
    const data = asRecord(payload.data);
    if (!data) throw invalidResponse("key");
    const label = typeof data.label === "string" ? scrub(data.label, apiKey) : null;
    return {
      // Unnamed keys are labelled with a masked form of the key: redact it like any secret.
      label: sanitizeProviderMessage(label, 120),
      limit: asFiniteNumber(data.limit),
      limitRemaining: asFiniteNumber(data.limit_remaining),
      usage: asFiniteNumber(data.usage),
      isFreeTier: typeof data.is_free_tier === "boolean" ? data.is_free_tier : null,
    };
  }

  /**
   * Streams a chat completion. Event order: one `meta` (from the first chunk), then `reasoning`
   * (activity only), `text` and `usage` events as they arrive, then exactly one `finish`.
   * OpenRouter may report usage more than once (final content chunk and trailing usage chunk);
   * each report is cumulative for the whole generation, so consumers keep the last `usage` event
   * and must never sum them.
   */
  async *streamChat(apiKey: string, request: StreamChatRequest): AsyncGenerator<ProviderStreamEvent, void, undefined> {
    const scope = new CallScope(request.signal);
    try {
      const body = JSON.stringify({
        model: request.modelId,
        messages: request.messages,
        stream: true,
        provider: { data_collection: request.dataCollection },
        ...(request.maxTokens === undefined ? {} : { max_tokens: request.maxTokens }),
      });
      const headers = { ...this.headers(apiKey, "text/event-stream"), "Content-Type": "application/json" };
      const response = await this.send(scope, "/chat/completions", { method: "POST", headers, body }, apiKey);
      if (!response.body) throw new ProviderError(providerErrorInfo("stream_interrupted"), "empty response body");

      const resetIdle = (): void => scope.arm(this.timeouts.idleMs, "idle_timeout");
      resetIdle();
      const state: StreamState = { metaSent: false, finishReason: null };
      let done = false;
      for await (const item of readSse(response.body, { signal: scope.signal, onBytes: resetIdle })) {
        if (item.kind === "comment") continue;
        if (item.data === "[DONE]") {
          done = true;
          break;
        }
        for (const event of interpretChunk(item.data, state)) yield event;
      }
      if (!done && state.finishReason === null) {
        throw new ProviderError(providerErrorInfo("stream_interrupted"), "stream ended before completion");
      }
      if (!state.metaSent) yield { type: "meta", servedModel: null, servedProvider: null, generationId: null };
      yield { type: "finish", finishReason: state.finishReason };
    } catch (error) {
      throw scope.failure(error, "stream_interrupted", apiKey);
    } finally {
      scope.dispose();
    }
  }

  private headers(apiKey: string | undefined, accept: string): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: accept,
      "HTTP-Referer": this.appUrl,
      "X-OpenRouter-Title": this.appTitle,
    };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    return headers;
  }

  private async getJson(path: string, apiKey: string | undefined, signal: AbortSignal | undefined): Promise<JsonRecord> {
    const scope = new CallScope(signal);
    try {
      const init = { method: "GET", headers: this.headers(apiKey, "application/json") };
      const response = await this.send(scope, path, init, apiKey);
      const payload = parseJsonRecord(await this.readText(response, scope));
      if (!payload) throw invalidResponse(path);
      return payload;
    } catch (error) {
      throw scope.failure(error, "network", apiKey);
    } finally {
      scope.dispose();
    }
  }

  /** Performs the request under `requestMs` until headers; non-2xx responses become ProviderError. */
  private async send(scope: CallScope, path: string, init: RequestInit, apiKey: string | undefined): Promise<Response> {
    scope.arm(this.timeouts.requestMs, "request_timeout");
    let response: Response;
    try {
      scope.signal.throwIfAborted();
      response = await this.fetchImpl(`${this.baseUrl}${path}`, { ...init, signal: scope.signal });
    } catch (error) {
      throw scope.failure(error, "network", apiKey);
    }
    if (response.ok) return response;
    // The error body is detail only: a failed read still reports the HTTP status, unless the user aborted.
    const text = await this.readText(response, scope).catch(() => "");
    if (scope.cause === "user") throw scope.failure(undefined, "network", apiKey);
    throw new ProviderError(mapHttpError(response.status, scrub(text, apiKey), response.headers));
  }

  /** Reads a whole body; the idle timer bounds the silence between chunks. */
  private async readText(response: Response, scope: CallScope): Promise<string> {
    if (!response.body) return "";
    const resetIdle = (): void => scope.arm(this.timeouts.idleMs, "idle_timeout");
    resetIdle();
    const decoder = new TextDecoder();
    let text = "";
    for await (const chunk of readChunks(response.body, scope.signal)) {
      resetIdle();
      text += decoder.decode(chunk, { stream: true });
    }
    return text + decoder.decode();
  }
}
