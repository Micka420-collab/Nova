import { randomUUID } from "node:crypto";
import {
  ProviderError,
  providerErrorInfo,
  type ModelProvider,
  type ProviderStreamEvent,
  type StreamChatRequest,
} from "@nova/providers";
import {
  DEFAULT_SETTINGS,
  type ChatStreamEvent,
  type KeyCheckResult,
  type ModelInfo,
  type UsageSummary,
} from "@nova/shared";
import { openNovaStore, type NovaStore } from "@nova/storage";
import { afterEach, describe, expect, it } from "vitest";
import { ChatRunner, RuntimeError, type ChatRunnerDeps, type RuntimeErrorCode } from "./chat-runner";
import { NOVA_SYSTEM_PROMPT } from "./prompt";

const MODEL = "author/model-a";
const OTHER_MODEL = "author/model-b";
const USAGE: UsageSummary = {
  promptTokens: 12,
  completionTokens: 7,
  reasoningTokens: 3,
  cachedTokens: null,
  cost: 0.0042,
};

type Script = (request: StreamChatRequest) => AsyncGenerator<ProviderStreamEvent>;

/** Provider whose streams are scripted per call, in order. */
class ScriptedProvider implements ModelProvider {
  readonly id = "openrouter" as const;
  readonly calls: { apiKey: string; request: StreamChatRequest }[] = [];
  private readonly scripts: Script[] = [];

  push(...scripts: Script[]): void {
    this.scripts.push(...scripts);
  }

  listModels(): Promise<ModelInfo[]> {
    return Promise.reject(new Error("not used"));
  }

  checkKey(): Promise<KeyCheckResult> {
    return Promise.reject(new Error("not used"));
  }

  streamChat(apiKey: string, request: StreamChatRequest): AsyncIterable<ProviderStreamEvent> {
    this.calls.push({ apiKey, request });
    const script = this.scripts.shift();
    if (!script) throw new Error("no scripted stream left");
    return script(request);
  }
}

function gate(): { open: () => void; opened: Promise<void> } {
  let open = () => {};
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}

/** Waits like a real stream would, failing with `aborted` when the request is cancelled. */
function waitOrAbort(opened: Promise<void>, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => reject(new ProviderError(providerErrorInfo("aborted"), "request aborted"));
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    void opened.then(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    });
  });
}

const text = (value: string): ProviderStreamEvent => ({ type: "text", text: value });

function answer(content: string, usage: UsageSummary | null = USAGE): Script {
  return async function* () {
    yield text(content);
    if (usage) yield { type: "usage", usage };
    yield { type: "finish", finishReason: "stop" };
  };
}

function failing(error: unknown, partial = ""): Script {
  return async function* () {
    if (partial) yield text(partial);
    throw error;
  };
}

/** Streams `partial`, then blocks until the gate opens or the request is aborted. */
function blocking(opened: Promise<void>, partial = "", rest = ""): Script {
  return async function* (request) {
    if (partial) yield text(partial);
    await waitOrAbort(opened, request.signal);
    if (rest) yield text(rest);
  };
}

const stores: NovaStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

function setup(overrides: Partial<ChatRunnerDeps> = {}) {
  const store = openNovaStore(":memory:");
  stores.push(store);
  const provider = new ScriptedProvider();
  const events: ChatStreamEvent[] = [];
  const waiters: { match: (event: ChatStreamEvent) => boolean; resolve: () => void }[] = [];
  const logs: { level: string; msg: string; data: Record<string, unknown> | undefined }[] = [];
  const keyRef: { value: string | null } = { value: "sk-or-v1-testkey000" };
  const runner = new ChatRunner({
    store,
    provider,
    resolveApiKey: () => Promise.resolve(keyRef.value),
    getSettings: () => DEFAULT_SETTINGS,
    emit: (event) => {
      events.push(event);
      for (const waiter of waiters.filter((w) => w.match(event))) waiter.resolve();
    },
    logger: {
      info: (msg, data) => logs.push({ level: "info", msg, data }),
      warn: (msg, data) => logs.push({ level: "warn", msg, data }),
      error: (msg, data) => logs.push({ level: "error", msg, data }),
    },
    ...overrides,
  });
  const waitFor = (match: (event: ChatStreamEvent) => boolean) =>
    new Promise<void>((resolve) => {
      if (events.some(match)) resolve();
      else waiters.push({ match, resolve });
    });
  return { store, provider, runner, events, logs, keyRef, waitFor };
}

const summary = (event: ChatStreamEvent): string => {
  if (event.type === "phase") return `phase:${event.phase}`;
  if (event.type === "delta") return `delta:${event.text}`;
  return event.type;
};
const terminals = (events: ChatStreamEvent[], streamId: string) =>
  events.filter((e) => e.streamId === streamId && ["completed", "stopped", "failed"].includes(e.type));

const runtimeError = (code: RuntimeErrorCode) => ({ name: "RuntimeError", code });
const fresh = (content: string) => ({ conversationId: null, content, modelId: MODEL });

describe("ChatRunner.send", () => {
  it("persists the exchange, streams events in order and records usage", async () => {
    const { store, provider, runner, events } = setup();
    provider.push(async function* () {
      yield {
        type: "meta",
        servedModel: "author/model-a-2026",
        servedProvider: "Upstream",
        generationId: "g1",
      };
      yield { type: "reasoning" };
      yield { type: "reasoning" };
      yield text("Bon");
      yield text("jour");
      yield { type: "usage", usage: USAGE };
      yield { type: "finish", finishReason: "stop" };
    });

    const result = await runner.send({ conversationId: null, content: "Dis bonjour\nmerci", modelId: MODEL });
    const { conversation, userMessage, assistantMessage, streamId } = result;
    expect(conversation).toMatchObject({ title: "Dis bonjour", modelId: MODEL });
    expect(userMessage).toMatchObject({ role: "user", status: "complete", content: "Dis bonjour\nmerci" });
    expect(assistantMessage).toMatchObject({
      role: "assistant",
      status: "streaming",
      content: "",
      modelId: MODEL,
    });
    expect(runner.active()).toEqual([
      {
        streamId,
        conversationId: conversation.id,
        messageId: assistantMessage.id,
        modelId: MODEL,
        phase: "waiting",
      },
    ]);
    expect(events).toEqual([]);

    await runner.idle();
    expect(events.map(summary)).toEqual([
      "phase:waiting",
      "meta",
      "phase:reasoning",
      "phase:writing",
      "delta:Bon",
      "delta:jour",
      "usage",
      "completed",
    ]);
    const stored = store.getMessage(assistantMessage.id);
    expect(stored).toMatchObject({
      status: "complete",
      content: "Bonjour",
      servedModel: "author/model-a-2026",
      servedProvider: "Upstream",
      usage: USAGE,
      error: null,
    });
    expect(events.at(-1)).toEqual({
      type: "completed",
      streamId,
      conversationId: conversation.id,
      message: stored,
    });
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]?.apiKey).toBe("sk-or-v1-testkey000");
    expect(provider.calls[0]?.request).toMatchObject({
      modelId: MODEL,
      dataCollection: "deny",
      messages: [
        { role: "system", content: NOVA_SYSTEM_PROMPT },
        { role: "user", content: "Dis bonjour\nmerci" },
      ],
    });
    expect(store.conversationUsage(conversation.id)).toEqual({
      promptTokens: 12,
      completionTokens: 7,
      cost: 0.0042,
      messagesWithUnknownCost: 0,
    });
    expect(runner.active()).toEqual([]);
  });

  it("refuses without a key and persists nothing", async () => {
    const { store, provider, runner, keyRef } = setup();
    keyRef.value = null;
    const sent = runner.send({ conversationId: null, content: "Salut", modelId: MODEL });
    await expect(sent).rejects.toBeInstanceOf(RuntimeError);
    await expect(sent).rejects.toMatchObject(runtimeError("no_key"));
    expect(store.listConversations()).toEqual([]);
    expect(provider.calls).toEqual([]);
  });

  it("rejects an unknown conversation", async () => {
    const { runner } = setup();
    await expect(
      runner.send({ conversationId: randomUUID(), content: "x", modelId: MODEL }),
    ).rejects.toMatchObject(runtimeError("not_found"));
  });

  it("allows a single active stream per conversation", async () => {
    const { store, provider, runner, events } = setup();
    const release = gate();
    provider.push(blocking(release.opened, "", "fin"), answer("autre"));
    const first = await runner.send({ conversationId: null, content: "Un", modelId: MODEL });
    await expect(
      runner.send({ conversationId: first.conversation.id, content: "Deux", modelId: MODEL }),
    ).rejects.toMatchObject(runtimeError("conflict"));
    const elsewhere = await runner.send({ conversationId: null, content: "Ailleurs", modelId: MODEL });
    const activeIds = runner.active().map((s) => s.streamId);
    expect(activeIds.sort()).toEqual([first.streamId, elsewhere.streamId].sort());

    release.open();
    await runner.idle();
    expect(terminals(events, first.streamId).map((e) => e.type)).toEqual(["completed"]);
    expect(store.listMessages(first.conversation.id).map((m) => m.content)).toEqual(["Un", "fin"]);
  });

  it("keeps the partial answer when the user stops the stream", async () => {
    const { store, provider, runner, events, waitFor } = setup();
    provider.push(blocking(gate().opened, "Partiel", "jamais"));
    const { streamId, assistantMessage } = await runner.send(fresh("Q"));
    await waitFor((e) => e.type === "delta");
    expect(runner.stop(streamId)).toBe(true);
    await runner.idle();

    expect(terminals(events, streamId).map((e) => e.type)).toEqual(["stopped"]);
    expect(store.getMessage(assistantMessage.id)).toMatchObject({
      status: "stopped",
      content: "Partiel",
      error: null,
    });
    expect(runner.stop(streamId)).toBe(false);
    expect(runner.active()).toEqual([]);
  });

  it("stores provider errors with the partial answer", async () => {
    const { store, provider, runner, events, logs } = setup();
    const info = providerErrorInfo("rate_limited", {
      httpStatus: 429,
      retryAfterSec: 3,
      providerMessage: "Slow down",
    });
    provider.push(failing(new ProviderError(info), "Début"));
    const { streamId, assistantMessage } = await runner.send(fresh("Q"));
    await runner.idle();

    const stored = store.getMessage(assistantMessage.id);
    expect(stored).toMatchObject({ status: "error", content: "Début", error: info });
    expect(terminals(events, streamId)).toEqual([
      {
        type: "failed",
        streamId,
        conversationId: assistantMessage.conversationId,
        message: stored,
        error: info,
      },
    ]);
    expect(logs.some((l) => l.level === "warn" && l.data?.["code"] === "rate_limited")).toBe(true);
  });

  it("turns unexpected exceptions into an unknown error and logs them redacted", async () => {
    const { store, provider, runner, events, logs } = setup();
    provider.push(failing(new TypeError("boom with sk-or-v1-leakedsecret42")));
    const { streamId, assistantMessage } = await runner.send(fresh("Q"));
    await runner.idle();

    expect(store.getMessage(assistantMessage.id)).toMatchObject({
      status: "error",
      error: { code: "unknown" },
    });
    expect(terminals(events, streamId).map((e) => e.type)).toEqual(["failed"]);
    const logged = JSON.stringify(logs.filter((l) => l.level === "error"));
    expect(logged).toContain("boom with");
    expect(logged).not.toContain("leakedsecret42");
  });

  it("sends only user turns and complete answers as history", async () => {
    const { provider, runner, waitFor } = setup();
    provider.push(failing(new ProviderError(providerErrorInfo("network")), "cassé"));
    const first = await runner.send({ conversationId: null, content: "Q1", modelId: MODEL });
    const conversationId = first.conversation.id;
    await runner.idle();

    provider.push(blocking(gate().opened, "coupé"));
    const second = await runner.send({ conversationId, content: "Q2", modelId: MODEL });
    await waitFor((e) => e.type === "delta" && e.streamId === second.streamId);
    runner.stop(second.streamId);
    await runner.idle();

    provider.push(answer("R3"), answer("R4"));
    await runner.send({ conversationId, content: "Q3", modelId: MODEL });
    await runner.idle();
    await runner.send({ conversationId, content: "Q4", modelId: MODEL });
    await runner.idle();

    expect(provider.calls.at(-1)?.request.messages).toEqual([
      { role: "system", content: NOVA_SYSTEM_PROMPT },
      { role: "user", content: "Q1" },
      { role: "user", content: "Q2" },
      { role: "user", content: "Q3" },
      { role: "assistant", content: "R3" },
      { role: "user", content: "Q4" },
    ]);
  });

  it("persists partial content while streaming, at most once per throttle window", async () => {
    let clock = 0;
    const { store, provider, runner, waitFor } = setup({ now: () => clock, persistThrottleMs: 400 });
    const second = gate();
    const third = gate();
    provider.push(async function* (request) {
      yield text("a");
      await waitOrAbort(second.opened, request.signal);
      yield text("b");
      await waitOrAbort(third.opened, request.signal);
      yield text("c");
    });
    const { assistantMessage } = await runner.send(fresh("Q"));

    await waitFor((e) => e.type === "delta" && e.text === "a");
    expect(store.getMessage(assistantMessage.id)?.content).toBe("");
    clock = 500;
    second.open();
    await waitFor((e) => e.type === "delta" && e.text === "b");
    expect(store.getMessage(assistantMessage.id)).toMatchObject({ content: "ab", status: "streaming" });
    clock = 600;
    third.open();
    await runner.idle();
    expect(store.getMessage(assistantMessage.id)).toMatchObject({ content: "abc", status: "complete" });
  });

  it("stopAll stops every active stream", async () => {
    const { provider, runner, events } = setup();
    provider.push(blocking(gate().opened), blocking(gate().opened));
    const a = await runner.send({ conversationId: null, content: "A", modelId: MODEL });
    const b = await runner.send({ conversationId: null, content: "B", modelId: MODEL });
    runner.stopAll();
    await runner.idle();
    expect(terminals(events, a.streamId).map((e) => e.type)).toEqual(["stopped"]);
    expect(terminals(events, b.streamId).map((e) => e.type)).toEqual(["stopped"]);
    expect(runner.active()).toEqual([]);
  });

  it("still persists and ends the stream when the event listener throws", async () => {
    const { store, provider, runner, logs } = setup({
      emit: () => {
        throw new Error("window closed");
      },
    });
    provider.push(answer("Réponse"));
    const { assistantMessage } = await runner.send(fresh("Q"));
    await runner.idle();
    expect(store.getMessage(assistantMessage.id)).toMatchObject({ status: "complete", content: "Réponse" });
    expect(logs.some((l) => l.msg === "chat event listener failed")).toBe(true);
  });

  it("emits a terminal event even if the conversation was deleted mid-stream", async () => {
    const { store, provider, runner, events, logs, waitFor } = setup();
    const release = gate();
    provider.push(async function* (request) {
      yield text("Début");
      await waitOrAbort(release.opened, request.signal);
      yield { type: "usage", usage: USAGE };
    });
    const { streamId, conversation, assistantMessage } = await runner.send({
      conversationId: null,
      content: "Q",
      modelId: MODEL,
    });
    await waitFor((e) => e.type === "delta");
    store.deleteConversation(conversation.id);
    release.open();
    await runner.idle();

    const [terminal] = terminals(events, streamId);
    expect(terminal).toMatchObject({
      type: "completed",
      message: { id: assistantMessage.id, content: "Début" },
    });
    expect(logs.some((l) => l.msg === "usage not recorded")).toBe(true);
    expect(runner.active()).toEqual([]);
  });
});

describe("ChatRunner.retry", () => {
  async function failedExchange() {
    const context = setup();
    const unavailable = providerErrorInfo("model_unavailable", { httpStatus: 502 });
    context.provider.push(failing(new ProviderError(unavailable)));
    const sent = await context.runner.send({ conversationId: null, content: "Q1", modelId: MODEL });
    await context.runner.idle();
    return { ...context, conversationId: sent.conversation.id, failedId: sent.assistantMessage.id };
  }

  it("replaces the failed last answer with a new generation", async () => {
    const { store, provider, runner, events, conversationId, failedId } = await failedExchange();
    provider.push(answer("R1"));
    const { assistantMessage, streamId } = await runner.retry({
      conversationId,
      assistantMessageId: failedId,
      modelId: OTHER_MODEL,
    });
    expect(assistantMessage).toMatchObject({ status: "streaming", modelId: OTHER_MODEL, content: "" });
    expect(store.getMessage(failedId)).toBeNull();
    await runner.idle();

    expect(terminals(events, streamId).map((e) => e.type)).toEqual(["completed"]);
    expect(store.listMessages(conversationId).map((m) => [m.content, m.status])).toEqual([
      ["Q1", "complete"],
      ["R1", "complete"],
    ]);
    expect(store.getConversation(conversationId)?.modelId).toBe(OTHER_MODEL);
    expect(provider.calls.at(-1)?.request).toMatchObject({
      modelId: OTHER_MODEL,
      messages: [
        { role: "system", content: NOVA_SYSTEM_PROMPT },
        { role: "user", content: "Q1" },
      ],
    });
  });

  it("only accepts the last answer when it failed, was stopped or interrupted", async () => {
    const { store, provider, runner, conversationId, failedId } = await failedExchange();
    const userId = store.listMessages(conversationId)[0]?.id ?? "";
    await expect(
      runner.retry({ conversationId, assistantMessageId: userId, modelId: MODEL }),
    ).rejects.toMatchObject(runtimeError("invalid_state"));

    provider.push(answer("R2"));
    await runner.send({ conversationId, content: "Q2", modelId: MODEL });
    await runner.idle();
    // The failed answer is no longer the last message, and a complete answer is not retryable.
    await expect(
      runner.retry({ conversationId, assistantMessageId: failedId, modelId: MODEL }),
    ).rejects.toMatchObject(runtimeError("invalid_state"));
    const completeId = store.listMessages(conversationId).at(-1)?.id ?? "";
    await expect(
      runner.retry({ conversationId, assistantMessageId: completeId, modelId: MODEL }),
    ).rejects.toMatchObject(runtimeError("invalid_state"));
  });

  it("retries an answer interrupted by a previous app run", async () => {
    const { store, provider, runner } = setup();
    const { id: conversationId } = store.createConversation({ title: "t", modelId: MODEL });
    store.insertMessage({ conversationId, role: "user", content: "Q", status: "complete", modelId: null });
    const lost = store.insertMessage({
      conversationId,
      role: "assistant",
      content: "par",
      status: "streaming",
      modelId: MODEL,
    });
    // A streaming message without an active stream is not retryable until recovery marks it.
    await expect(
      runner.retry({ conversationId, assistantMessageId: lost.id, modelId: MODEL }),
    ).rejects.toMatchObject(runtimeError("invalid_state"));
    store.markInterruptedStreams();
    provider.push(answer("R"));
    await runner.retry({ conversationId, assistantMessageId: lost.id, modelId: MODEL });
    await runner.idle();
    expect(store.listMessages(conversationId).map((m) => m.content)).toEqual(["Q", "R"]);
  });

  it("reports missing targets, conflicts and missing keys", async () => {
    const { provider, runner, keyRef, conversationId, failedId } = await failedExchange();
    await expect(
      runner.retry({ conversationId, assistantMessageId: randomUUID(), modelId: MODEL }),
    ).rejects.toMatchObject(runtimeError("not_found"));
    await expect(
      runner.retry({ conversationId: randomUUID(), assistantMessageId: failedId, modelId: MODEL }),
    ).rejects.toMatchObject(runtimeError("not_found"));

    provider.push(blocking(gate().opened));
    const other = await runner.send({ conversationId: null, content: "Autre", modelId: MODEL });
    await expect(
      runner.retry({ conversationId: other.conversation.id, assistantMessageId: failedId, modelId: MODEL }),
    ).rejects.toMatchObject(runtimeError("not_found"));
    const retryActive = {
      conversationId: other.conversation.id,
      assistantMessageId: other.assistantMessage.id,
      modelId: MODEL,
    };
    await expect(runner.retry(retryActive)).rejects.toMatchObject(runtimeError("conflict"));
    runner.stopAll();
    await runner.idle();

    keyRef.value = null;
    await expect(
      runner.retry({ conversationId, assistantMessageId: failedId, modelId: MODEL }),
    ).rejects.toMatchObject(runtimeError("no_key"));
  });
});
