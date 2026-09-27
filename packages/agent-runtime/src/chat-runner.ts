// Chat orchestration for the Electron main process: conversation -> provider stream -> storage,
// with live events for the renderer. One active stream per conversation.
import { randomUUID } from "node:crypto";
import { ProviderError, providerErrorInfo, type ModelProvider } from "@nova/providers";
import {
  redactSecrets,
  type ActiveStream,
  type AppSettings,
  type ChatRetryRequest,
  type ChatRetryResult,
  type ChatSendRequest,
  type ChatSendResult,
  type ChatStreamEvent,
  type Message,
  type MessageStatus,
  type ProviderErrorInfo,
  type StreamPhase,
  type UsageSummary,
} from "@nova/shared";
import type { MessagePatch, NovaStore } from "@nova/storage";
import { buildConversationTitle, buildProviderMessages } from "./prompt";

export interface RuntimeLogger {
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

export interface ChatRunnerDeps {
  store: NovaStore;
  provider: ModelProvider;
  resolveApiKey: () => Promise<string | null>;
  getSettings: () => AppSettings;
  emit: (event: ChatStreamEvent) => void;
  now?: () => number;
  /** Minimum delay between two writes of the partial answer while streaming. */
  persistThrottleMs?: number;
  logger?: RuntimeLogger;
  /**
   * A generation failed with a provider error (not a stop). Lets the owner of the connection
   * record facts such as a rejected key; `apiKey` is the key that was used, to ignore a stale
   * report after the key changed. Awaited before the `failed` event, so a listener reacting to
   * that event reads the recorded fact.
   */
  onProviderError?: (error: ProviderErrorInfo, apiKey: string) => void | Promise<void>;
}

export type RuntimeErrorCode = "no_key" | "not_found" | "conflict" | "invalid_state";

export class RuntimeError extends Error {
  readonly code: RuntimeErrorCode;
  constructor(code: RuntimeErrorCode, message: string) {
    super(message);
    this.name = "RuntimeError";
    this.code = code;
  }
}

const DEFAULT_PERSIST_THROTTLE_MS = 400;
const RETRYABLE_STATUSES: ReadonlySet<MessageStatus> = new Set(["error", "stopped", "interrupted"]);
/** A possibly billed generation whose usage was never reported: recorded with every figure unknown. */
const UNKNOWN_USAGE: UsageSummary = {
  promptTokens: null,
  completionTokens: null,
  reasoningTokens: null,
  cachedTokens: null,
  cost: null,
};
const CONSOLE_LOGGER: RuntimeLogger = {
  info: () => {},
  warn: (msg, data) => console.warn(msg, data ?? {}),
  error: (msg, data) => console.error(msg, data ?? {}),
};

interface StreamRun {
  readonly streamId: string;
  readonly conversationId: string;
  readonly modelId: string;
  /** The assistant message as inserted (status `streaming`). */
  readonly message: Message;
  readonly controller: AbortController;
  phase: StreamPhase;
  readonly progress: Progress;
  /**
   * Retry only: the answer being replaced. It stays stored until this run produces reasoning or
   * text (or completes), then it is deleted; if the run ends without producing anything, the new
   * row is deleted instead and this answer remains the conversation's last one.
   */
  supersedes: Message | null;
}

interface Progress {
  content: string;
  usage: UsageSummary | null;
  servedModel: string | null;
  servedProvider: string | null;
  finishReason: string | null;
  /** The provider answered the request (any stream event): the generation may be billed. */
  started: boolean;
}

type Outcome =
  | { status: "complete" }
  | { status: "stopped" }
  | { status: "error"; error: ProviderErrorInfo };

function describeError(error: unknown): string {
  return redactSecrets(error instanceof Error ? (error.stack ?? error.message) : String(error));
}

/**
 * Events of a stream are emitted only after `send()`/`retry()` resolved (generation starts on
 * the next macrotask), and every stream ends with exactly one `completed`, `stopped` or `failed`
 * event, emitted after the stream left `active()`. At quit: `stopAll()`, then `await idle()`
 * before closing the store.
 *
 * A generation that finished at its token limit (`truncated`, partial text kept), was cut by the
 * content filter (`filtered`) or completed without any text (`empty_response`) ends `failed`.
 *
 * Retry keeps the previous answer until the new one produces something. When the retry ends
 * before producing reasoning or text (e.g. HTTP 429, offline, stopped while waiting), its new
 * row is deleted and the previous answer stays stored: the terminal event still carries the new
 * (now deleted) message and its error, and `conversations.get` returns the previous answer again.
 */
export class ChatRunner {
  private readonly runs = new Map<string, StreamRun>();
  private readonly tasks = new Set<Promise<void>>();
  private readonly now: () => number;
  private readonly persistThrottleMs: number;
  private readonly logger: RuntimeLogger;

  constructor(private readonly deps: ChatRunnerDeps) {
    this.now = deps.now ?? Date.now;
    this.persistThrottleMs = deps.persistThrottleMs ?? DEFAULT_PERSIST_THROTTLE_MS;
    this.logger = deps.logger ?? CONSOLE_LOGGER;
  }

  async send(req: ChatSendRequest): Promise<ChatSendResult> {
    const apiKey = await this.requireApiKey();
    // Synchronous from here: no other send/retry can interleave between checks and writes.
    const { store } = this.deps;
    let conversationId: string;
    if (req.conversationId === null) {
      const title = buildConversationTitle(req.content);
      conversationId = store.createConversation({ title, modelId: req.modelId }).id;
    } else {
      const existing = store.getConversation(req.conversationId);
      if (!existing) throw new RuntimeError("not_found", "Conversation not found");
      this.assertNoActiveStream(existing.id);
      conversationId = existing.id;
    }
    const userMessage = store.insertMessage({
      conversationId,
      role: "user",
      content: req.content,
      status: "complete",
      modelId: null,
    });
    const run = this.startRun(conversationId, req.modelId, apiKey);
    const conversation = store.getConversation(conversationId);
    if (!conversation) throw new Error("Conversation vanished while starting a stream");
    return { conversation, userMessage, assistantMessage: run.message, streamId: run.streamId };
  }

  /** Regenerates the last answer of a conversation when it failed, was stopped or interrupted. */
  async retry(req: ChatRetryRequest): Promise<ChatRetryResult> {
    const apiKey = await this.requireApiKey();
    const { store } = this.deps;
    const conversation = store.getConversation(req.conversationId);
    const target = store.getMessage(req.assistantMessageId);
    if (!conversation || !target || target.conversationId !== conversation.id) {
      throw new RuntimeError("not_found", "Message not found in this conversation");
    }
    this.assertNoActiveStream(conversation.id);
    const last = store.listMessages(conversation.id).at(-1);
    if (last?.id !== target.id || target.role !== "assistant" || !RETRYABLE_STATUSES.has(target.status)) {
      throw new RuntimeError(
        "invalid_state",
        "Only the last answer can be retried, and only after an error, a stop or an interruption",
      );
    }
    // The target stays in the history but is not context: only complete answers are sent.
    const run = this.startRun(conversation.id, req.modelId, apiKey, target);
    return { assistantMessage: run.message, streamId: run.streamId };
  }

  /**
   * Stored messages as they are right now: an active answer carries its in-memory text (writes
   * are throttled), and an answer being replaced by a running retry is hidden.
   */
  overlayLive(messages: Message[]): Message[] {
    const live = new Map<string, StreamRun>();
    const replaced = new Set<string>();
    for (const run of this.runs.values()) {
      live.set(run.message.id, run);
      if (run.supersedes) replaced.add(run.supersedes.id);
    }
    return messages
      .filter((message) => !replaced.has(message.id))
      .map((message) => {
        const run = live.get(message.id);
        return run ? { ...message, content: run.progress.content } : message;
      });
  }

  /** Requests a stop; the stream then ends with a `stopped` event. False when not active. */
  stop(streamId: string): boolean {
    const run = this.runs.get(streamId);
    if (!run) return false;
    run.controller.abort();
    return true;
  }

  stopAll(): void {
    for (const run of this.runs.values()) run.controller.abort();
  }

  active(): ActiveStream[] {
    return [...this.runs.values()].map((run) => ({
      streamId: run.streamId,
      conversationId: run.conversationId,
      messageId: run.message.id,
      modelId: run.modelId,
      phase: run.phase,
    }));
  }

  /** Resolves once every started generation has settled and persisted its outcome. */
  async idle(): Promise<void> {
    while (this.tasks.size > 0) await Promise.allSettled(this.tasks);
  }

  // -------------------------------------------------------------------------

  private async requireApiKey(): Promise<string> {
    const apiKey = await this.deps.resolveApiKey();
    if (!apiKey) throw new RuntimeError("no_key", "No API key available for the provider");
    return apiKey;
  }

  private assertNoActiveStream(conversationId: string): void {
    for (const run of this.runs.values()) {
      if (run.conversationId === conversationId) {
        throw new RuntimeError("conflict", "A generation is already running in this conversation");
      }
    }
  }

  private startRun(
    conversationId: string,
    modelId: string,
    apiKey: string,
    supersedes: Message | null = null,
  ): StreamRun {
    const { store } = this.deps;
    const history = store.listMessages(conversationId);
    const message = store.insertMessage({
      conversationId,
      role: "assistant",
      content: "",
      status: "streaming",
      modelId,
    });
    store.touchConversation(conversationId, modelId);
    const run: StreamRun = {
      streamId: randomUUID(),
      conversationId,
      modelId,
      message,
      controller: new AbortController(),
      phase: "waiting",
      progress: {
        content: "",
        usage: null,
        servedModel: null,
        servedProvider: null,
        finishReason: null,
        started: false,
      },
      supersedes,
    };
    this.runs.set(run.streamId, run);
    const task: Promise<void> = new Promise<void>((resolve) => setImmediate(resolve))
      .then(() => this.generate(run, apiKey, history))
      .catch((error: unknown) => {
        this.logger.error("chat stream task failed", { streamId: run.streamId, error: describeError(error) });
      })
      .finally(() => {
        this.tasks.delete(task);
      });
    this.tasks.add(task);
    return run;
  }

  private async generate(run: StreamRun, apiKey: string, history: Message[]): Promise<void> {
    const { progress } = run;
    let outcome: Outcome;
    try {
      await this.consume(run, apiKey, history);
      outcome = run.controller.signal.aborted ? { status: "stopped" } : this.finished(run);
    } catch (error) {
      outcome = this.classify(run, error);
      if (outcome.status === "error" && error instanceof ProviderError) {
        await this.reportProviderError(outcome.error, apiKey);
      }
    }
    let terminal: ChatStreamEvent;
    try {
      terminal = this.settle(run, outcome);
    } finally {
      // Leave active() before the terminal event so a listener can start the next turn.
      this.runs.delete(run.streamId);
    }
    this.logger.info("chat stream ended", {
      streamId: run.streamId,
      conversationId: run.conversationId,
      status: outcome.status,
      chars: progress.content.length,
    });
    this.emit(terminal);
  }

  private async consume(run: StreamRun, apiKey: string, history: Message[]): Promise<void> {
    const { store, provider } = this.deps;
    const { progress } = run;
    const { signal } = run.controller;
    const messageId = run.message.id;
    this.emit({ type: "phase", ...this.ids(run), phase: "waiting" });
    if (signal.aborted) return;
    const events = provider.streamChat(apiKey, {
      modelId: run.modelId,
      messages: buildProviderMessages(history),
      signal,
      dataCollection: this.deps.getSettings().privacy.providerDataCollection,
    });
    let persistedAt = this.now();
    for await (const event of events) {
      if (signal.aborted) break;
      progress.started = true;
      switch (event.type) {
        case "meta": {
          progress.servedModel = event.servedModel ?? progress.servedModel;
          progress.servedProvider = event.servedProvider ?? progress.servedProvider;
          const { servedModel, servedProvider } = progress;
          store.updateMessage(messageId, { servedModel, servedProvider });
          this.emit({ type: "meta", ...this.ids(run), servedModel, servedProvider });
          break;
        }
        case "reasoning":
          this.replaceSuperseded(run);
          this.setPhase(run, "reasoning");
          break;
        case "text": {
          if (event.text === "") break;
          this.replaceSuperseded(run);
          this.setPhase(run, "writing");
          progress.content += event.text;
          this.emit({ type: "delta", ...this.ids(run), text: event.text });
          const now = this.now();
          if (now - persistedAt >= this.persistThrottleMs) {
            store.updateMessage(messageId, { content: progress.content });
            persistedAt = now;
          }
          break;
        }
        case "usage":
          progress.usage = event.usage;
          this.emit({ type: "usage", ...this.ids(run), usage: event.usage });
          break;
        case "finish":
          progress.finishReason = event.finishReason;
          break;
      }
    }
  }

  /** Outcome of a stream that ended normally: only a whole, non-empty answer is `complete`. */
  private finished(run: StreamRun): Outcome {
    const { finishReason, content } = run.progress;
    let code: "truncated" | "filtered" | "empty_response" | null = null;
    if (finishReason === "length") code = "truncated";
    else if (finishReason === "content_filter") code = "filtered";
    else if (content.trim() === "") code = "empty_response";
    if (code === null) return { status: "complete" };
    this.logger.warn("chat stream ended without a complete answer", {
      streamId: run.streamId,
      code,
      finishReason,
      chars: content.length,
    });
    return { status: "error", error: providerErrorInfo(code) };
  }

  /** Deletes the answer a retry replaces, once the retry has produced something of its own. */
  private replaceSuperseded(run: StreamRun): void {
    const target = run.supersedes;
    if (!target) return;
    run.supersedes = null;
    try {
      this.deps.store.supersedeMessage(target.id, { providerId: this.deps.provider.id, modelId: run.modelId });
    } catch (storeError) {
      this.logger.error("replaced answer not deleted", { streamId: run.streamId, error: describeError(storeError) });
    }
  }

  private async reportProviderError(error: ProviderErrorInfo, apiKey: string): Promise<void> {
    try {
      await this.deps.onProviderError?.(error, apiKey);
    } catch (listenerError) {
      this.logger.error("provider error listener failed", { error: describeError(listenerError) });
    }
  }

  private classify(run: StreamRun, error: unknown): Outcome {
    const aborted = error instanceof ProviderError && error.info.code === "aborted";
    // Whatever the provider throws after a user stop is a consequence of that stop.
    if (aborted || run.controller.signal.aborted) return { status: "stopped" };
    if (error instanceof ProviderError) {
      this.logger.warn("chat stream failed", {
        streamId: run.streamId,
        code: error.info.code,
        httpStatus: error.info.httpStatus,
      });
      return { status: "error", error: error.info };
    }
    this.logger.error("chat stream crashed", {
      streamId: run.streamId,
      conversationId: run.conversationId,
      error: describeError(error),
    });
    return { status: "error", error: providerErrorInfo("unknown") };
  }

  /**
   * Persists the outcome and returns the terminal event. Storage failures never swallow it.
   * A possibly billed generation always leaves a usage record, with a null cost when none was
   * reported (complete, stopped, or failed after the provider started answering).
   */
  private settle(run: StreamRun, outcome: Outcome): ChatStreamEvent {
    const { store, provider } = this.deps;
    const { progress } = run;
    // A complete answer is a replacement even if it never streamed reasoning or text.
    if (outcome.status === "complete") this.replaceSuperseded(run);
    const error = outcome.status === "error" ? outcome.error : null;
    const patch = {
      content: progress.content,
      status: outcome.status,
      servedModel: progress.servedModel,
      servedProvider: progress.servedProvider,
      error,
      usage: progress.usage,
    } satisfies MessagePatch;
    let message: Message | null = null;
    try {
      message = store.updateMessage(run.message.id, patch);
    } catch (storeError) {
      this.logger.error("chat outcome not persisted", {
        streamId: run.streamId,
        error: describeError(storeError),
      });
    }
    // Deleted meanwhile or not writable: report the in-memory outcome anyway.
    message ??= { ...run.message, ...patch, updatedAt: this.now() };
    // Reported usage implies a started generation, so this also covers every reported usage.
    const possiblyBilled = outcome.status !== "error" || progress.started;
    if (possiblyBilled) {
      try {
        store.recordUsage({
          conversationId: run.conversationId,
          messageId: run.message.id,
          providerId: provider.id,
          modelId: run.modelId,
          servedModel: progress.servedModel,
          servedProvider: progress.servedProvider,
          usage: progress.usage ?? UNKNOWN_USAGE,
        });
      } catch (usageError) {
        this.logger.error("usage not recorded", { streamId: run.streamId, error: describeError(usageError) });
      }
    }
    if (run.supersedes) {
      // The retry produced nothing: the previous answer stays the conversation's last one.
      try {
        store.deleteMessage(run.message.id);
      } catch (storeError) {
        this.logger.error("empty retry not removed", { streamId: run.streamId, error: describeError(storeError) });
      }
    }
    const base = { streamId: run.streamId, conversationId: run.conversationId, message };
    if (outcome.status === "complete") return { type: "completed", ...base };
    if (outcome.status === "stopped") return { type: "stopped", ...base };
    return { type: "failed", ...base, error: outcome.error };
  }

  private setPhase(run: StreamRun, phase: StreamPhase): void {
    if (run.phase === phase) return;
    run.phase = phase;
    this.emit({ type: "phase", ...this.ids(run), phase });
  }

  private ids(run: StreamRun): { streamId: string; conversationId: string; messageId: string } {
    return { streamId: run.streamId, conversationId: run.conversationId, messageId: run.message.id };
  }

  /** A failing listener (e.g. a closed window) must not break the generation or its persistence. */
  private emit(event: ChatStreamEvent): void {
    try {
      this.deps.emit(event);
    } catch (error) {
      this.logger.error("chat event listener failed", { type: event.type, error: describeError(error) });
    }
  }
}
