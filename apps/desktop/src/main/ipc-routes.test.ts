import { ChatRunner, RuntimeError, type RuntimeLogger } from "@nova/agent-runtime";
import { ProviderError, providerErrorInfo, type ModelProvider, type ProviderStreamEvent } from "@nova/providers";
import { IPC_CHANNELS, type AppInfo, type ChatStreamEvent, type IpcResult } from "@nova/shared";
import { openNovaStore, type NovaStore } from "@nova/storage";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createMainApi } from "./api";
import { buildIpcRoutes, toIpcError, type IpcRoute } from "./ipc-routes";
import { ServiceError } from "./service-error";
import { ChatEventHub } from "./services/chat-events";
import { VaultError } from "./vault";

const SECRET = "sk-or-v1-leaky-secret-0000000000000000000000";
const MODEL = "author/model";
const INFO: AppInfo = {
  version: "0.1.0",
  platform: "linux",
  arch: "x64",
  isPackaged: false,
  electronVersion: "44.4.5",
  dataDir: "/data",
  logDir: "/data/logs",
  vault: { level: "weak", backend: "basic_text" },
};

/** Streams one word, then waits for an abort; like a real socket, the abort lands a few ms later. */
class BlockingProvider implements ModelProvider {
  readonly id = "openrouter" as const;
  listModels = () => Promise.reject(new Error("not used"));
  checkKey = () => Promise.reject(new Error("not used"));
  async *streamChat(_apiKey: string, request: { signal: AbortSignal }): AsyncGenerator<ProviderStreamEvent> {
    yield { type: "text", text: "partial" };
    await new Promise<void>((_resolve, reject) => {
      const onAbort = () => setTimeout(() => reject(new ProviderError(providerErrorInfo("aborted"))), 20);
      request.signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}

const stores: NovaStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

function setup(overrides: { appInfo?: () => Promise<AppInfo> } = {}) {
  const store = openNovaStore(":memory:");
  stores.push(store);
  const logs: { level: string; msg: string; data?: Record<string, unknown> }[] = [];
  const logger: RuntimeLogger = {
    info: (msg, data) => logs.push({ level: "info", msg, data }),
    warn: (msg, data) => logs.push({ level: "warn", msg, data }),
    error: (msg, data) => logs.push({ level: "error", msg, data }),
  };
  const events: ChatStreamEvent[] = [];
  const chatEvents = new ChatEventHub((event) => events.push(event));
  const runner = new ChatRunner({
    store,
    provider: new BlockingProvider(),
    resolveApiKey: async () => SECRET,
    getSettings: () => store.getSettings(),
    emit: chatEvents.emit,
    logger,
  });
  const unused = () => Promise.reject(new Error("not used"));
  const api = createMainApi({
    store,
    runner,
    chatEvents,
    connections: { get: () => { throw new Error("not used"); }, setKey: unused, test: unused, remove: unused },
    catalog: { catalog: unused },
    app: { info: overrides.appInfo ?? (async () => INFO), openExternal: async () => {} },
  });
  const routes = new Map<string, IpcRoute>(buildIpcRoutes(api, logger).map((route) => [route.channel, route]));
  const call = (channel: string, payload?: unknown): Promise<IpcResult<unknown>> => {
    const route = routes.get(channel);
    if (!route) throw new Error(`no route for ${channel}`);
    return route.handle(payload);
  };
  return { store, runner, routes, call, logs, events };
}

describe("toIpcError", () => {
  it("maps known failures to their IPC code", () => {
    const providerInfo = providerErrorInfo("rate_limited", { httpStatus: 429, retryAfterSec: 7 });
    expect(toIpcError(new ProviderError(providerInfo))).toEqual({
      code: "provider",
      message: "Provider error: rate_limited",
      providerError: providerInfo,
    });
    expect(toIpcError(new RuntimeError("no_key", "no key")).code).toBe("no_key");
    expect(toIpcError(new RuntimeError("not_found", "missing")).code).toBe("not_found");
    expect(toIpcError(new RuntimeError("conflict", "busy")).code).toBe("conflict");
    expect(toIpcError(new RuntimeError("invalid_state", "not retryable")).code).toBe("conflict");
    expect(toIpcError(new VaultError("locked")).code).toBe("vault_unavailable");
    expect(toIpcError(new ServiceError("invalid_request", "URL not allowed")).code).toBe("invalid_request");
    expect(toIpcError(new z.ZodError([]))).toEqual({ code: "invalid_request", message: "Invalid request" });
  });

  it("never forwards the message of an unexpected error", () => {
    expect(toIpcError(new Error(`boom ${SECRET}`))).toEqual({ code: "internal", message: "Internal error" });
  });
});

describe("buildIpcRoutes", () => {
  it("routes every request channel exactly once (the push channel excluded)", () => {
    const { routes } = setup();
    const expected = Object.values(IPC_CHANNELS).filter((channel) => channel !== IPC_CHANNELS.chatEvent);
    expect([...routes.keys()].sort()).toEqual([...expected].sort());
  });

  it("rejects invalid payloads with field names only, never the submitted values", async () => {
    const { call, logs } = setup();
    const result = await call(IPC_CHANNELS.connectionSetKey, {
      providerId: "openrouter",
      apiKey: `${SECRET} with spaces`,
      storage: "cloud",
    });
    expect(result).toEqual({ ok: false, error: { code: "invalid_request", message: "Invalid request: apiKey, storage" } });
    expect(JSON.stringify(logs)).not.toContain("leaky");

    await expect(call(IPC_CHANNELS.settingsUpdate, { theme: "dark", extra: SECRET })).resolves.toMatchObject({
      ok: false,
      error: { code: "invalid_request" },
    });
    await expect(call(IPC_CHANNELS.appInfo, { unexpected: true })).resolves.toMatchObject({
      ok: false,
      error: { code: "invalid_request" },
    });
  });

  it("wraps values and maps service failures", async () => {
    const { call } = setup();
    await expect(call(IPC_CHANNELS.appInfo)).resolves.toEqual({ ok: true, value: INFO });
    await expect(call(IPC_CHANNELS.settingsUpdate, { theme: "dark" })).resolves.toMatchObject({
      ok: true,
      value: { theme: "dark" },
    });
    await expect(
      call(IPC_CHANNELS.conversationsGet, { conversationId: "7f1c1b8e-7a8f-4d7c-9a51-1c2c3d4e5f60" }),
    ).resolves.toMatchObject({ ok: false, error: { code: "not_found" } });
    await expect(
      call(IPC_CHANNELS.chatStop, { streamId: "7f1c1b8e-7a8f-4d7c-9a51-1c2c3d4e5f60" }),
    ).resolves.toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("returns internal errors without their message and logs them redacted", async () => {
    const { call, logs } = setup({ appInfo: () => Promise.reject(new Error(`vault dump ${SECRET}`)) });
    await expect(call(IPC_CHANNELS.appInfo)).resolves.toEqual({
      ok: false,
      error: { code: "internal", message: "Internal error" },
    });
    const entry = logs.find((log) => log.msg === "ipc handler failed");
    expect(entry?.data?.channel).toBe(IPC_CHANNELS.appInfo);
    expect(JSON.stringify(entry)).toContain("vault dump");
    expect(JSON.stringify(entry)).not.toContain(SECRET);
  });

  it("deletes a conversation only after its running generation stopped and persisted", async () => {
    const { call, runner, store, events, logs } = setup();
    const sent = await call(IPC_CHANNELS.chatSend, { conversationId: null, content: "Bonjour", modelId: MODEL });
    if (!sent.ok) throw new Error("send failed");
    const { conversation } = sent.value as { conversation: { id: string } };
    await expect.poll(() => events.some((event) => event.type === "delta")).toBe(true);

    await expect(call(IPC_CHANNELS.conversationsDelete, { conversationId: conversation.id })).resolves.toEqual({
      ok: true,
      value: undefined,
    });
    expect(events.at(-1)?.type).toBe("stopped");
    expect(runner.active()).toEqual([]);
    expect(store.getConversation(conversation.id)).toBeNull();
    expect(logs.filter((log) => log.level === "error")).toEqual([]);
    await expect(call(IPC_CHANNELS.conversationsDelete, { conversationId: conversation.id })).resolves.toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
  });
});
