import { ChatRunner, RuntimeError, type RuntimeLogger } from "@nova/agent-runtime";
import { ProviderError, providerErrorInfo, type ModelProvider, type ProviderStreamEvent } from "@nova/providers";
import { IPC_CHANNELS, PUSH_CHANNELS, type AppInfo, type ChatStreamEvent, type IpcResult } from "@nova/shared";
import { openNovaStore, type NovaStore } from "@nova/storage";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createMainApi, type AtelierApi, type AtelierGroup } from "./api";
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

const ATELIER_GROUPS: readonly AtelierGroup[] = [
  "workspace",
  "files",
  "search",
  "terminal",
  "missions",
  "approvals",
  "permissions",
  "audit",
  "git",
  "mcp",
  "web",
  "companion",
  "checkpoints",
];

/** J2-A services are tested on their own: here every call is recorded and refused. */
function recordingAtelier(calls: string[]): AtelierApi {
  const group = (name: string): unknown =>
    new Proxy(
      {},
      {
        get: (_target, method) => async () => {
          calls.push(`${name}.${String(method)}`);
          throw new ServiceError("unavailable", `${name}.${String(method)} stub`);
        },
      },
    );
  return Object.fromEntries(ATELIER_GROUPS.map((name) => [name, group(name)])) as AtelierApi;
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
  const serviceCalls: string[] = [];
  const api = createMainApi({
    atelier: recordingAtelier(serviceCalls),
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
  return { store, runner, routes, call, logs, events, serviceCalls };
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
    expect(toIpcError(new ServiceError("key_unreadable", "Stored key cannot be decrypted"))).toEqual({
      code: "key_unreadable",
      message: "Stored key cannot be decrypted",
    });
    expect(toIpcError(new z.ZodError([]))).toEqual({ code: "invalid_request", message: "Invalid request" });
  });

  it("never forwards the message of an unexpected error", () => {
    expect(toIpcError(new Error(`boom ${SECRET}`))).toEqual({ code: "internal", message: "Internal error" });
  });
});

describe("buildIpcRoutes", () => {
  it("routes every request channel exactly once (push channels excluded)", () => {
    const { routes } = setup();
    const expected = Object.values(IPC_CHANNELS).filter((channel) => !PUSH_CHANNELS.includes(channel));
    expect([...routes.keys()].sort()).toEqual([...expected].sort());
    expect(routes.size).toBe(expected.length);
  });

  it("validates J2-A requests before any service sees them, and forwards typed service errors", async () => {
    const { call, serviceCalls } = setup();
    const workspaceId = "7f1c1b8e-7a8f-4d7c-9a51-1c2c3d4e5f60";
    await expect(call(IPC_CHANNELS.filesRead, { workspaceId, path: "src/app.ts" })).resolves.toEqual({
      ok: false,
      error: { code: "unavailable", message: "files.read stub" },
    });
    expect(serviceCalls).toEqual(["files.read"]);
    // Validation still runs first: traversal and absolute paths never reach a service.
    for (const path of ["../etc/passwd", "/etc/passwd", "src/../../x", "C:/Windows", "a\\b", "a//b", "./a"]) {
      await expect(call(IPC_CHANNELS.filesRead, { workspaceId, path })).resolves.toMatchObject({
        ok: false,
        error: { code: "invalid_request", message: "Invalid request: path" },
      });
    }
    expect(serviceCalls).toEqual(["files.read"]);
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
  });

  it("treats a stop of a stream that already ended as done, not as a missing element", async () => {
    const { call, runner } = setup();
    const sent = await call(IPC_CHANNELS.chatSend, { conversationId: null, content: "Bonjour", modelId: MODEL });
    if (!sent.ok) throw new Error("send failed");
    const { streamId } = sent.value as { streamId: string };
    await expect(call(IPC_CHANNELS.chatStop, { streamId })).resolves.toEqual({ ok: true, value: undefined });
    await runner.idle();
    await expect(call(IPC_CHANNELS.chatStop, { streamId })).resolves.toEqual({ ok: true, value: undefined });
  });

  it("lists conversations as a page and returns the live text of a running answer", async () => {
    const { call, runner, events } = setup();
    const sent = await call(IPC_CHANNELS.chatSend, { conversationId: null, content: "Bonjour", modelId: MODEL });
    if (!sent.ok) throw new Error("send failed");
    const { conversation, assistantMessage, streamId } = sent.value as {
      conversation: { id: string };
      assistantMessage: { id: string };
      streamId: string;
    };
    await expect.poll(() => events.some((event) => event.type === "delta")).toBe(true);

    await expect(call(IPC_CHANNELS.conversationsList, {})).resolves.toMatchObject({
      ok: true,
      value: { items: [{ id: conversation.id }], hasMore: false },
    });
    // The first delta is below the persistence throttle: only the runner holds it.
    await expect(call(IPC_CHANNELS.conversationsGet, { conversationId: conversation.id })).resolves.toMatchObject({
      ok: true,
      value: {
        messages: [{ content: "Bonjour" }, { id: assistantMessage.id, content: "partial", status: "streaming" }],
      },
    });
    runner.stop(streamId);
    await runner.idle();
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
