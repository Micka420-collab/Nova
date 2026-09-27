import type { MissionController, ProxyStreamEvent, ProxyStreamRequest } from "@nova/missions";
import { ProviderError, providerErrorInfo, type ProviderStreamEvent, type StreamChatRequest } from "@nova/providers";
import type { ModelInfo } from "@nova/shared";
import { describe, expect, it } from "vitest";
import { createProviderProxyHost } from "./provider-proxy";

const KEY = "sk-or-v1-0123456789abcdef0123456789abcdef";
const MISSION = "33333333-3333-4333-8333-333333333333";

const MODEL: ModelInfo = {
  id: "acme/tools",
  name: "Tools",
  author: "acme",
  description: null,
  contextLength: 100_000,
  maxCompletionTokens: null,
  inputModalities: null,
  outputModalities: null,
  supportsTools: true,
  supportsStructuredOutputs: null,
  supportsReasoning: null,
  pricing: { promptPerMTok: 1, completionPerMTok: 2, variable: false },
  isFree: false,
  expirationDate: null,
  createdAt: null,
};

function request(overrides: Partial<ProxyStreamRequest> = {}): ProxyStreamRequest {
  return {
    missionId: MISSION,
    modelId: MODEL.id,
    messages: [
      { role: "system", content: "s" },
      { role: "user", content: "u" },
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: "{}" }], reasoningDetails: [{ type: "reasoning.encrypted", data: "x" }] },
      { role: "tool", toolCallId: "c1", content: "r" },
    ],
    tools: [{ name: "read_file", description: "read", inputSchema: { type: "object" }, operation: "read" }],
    webSearch: false,
    maxTokens: 1_000,
    purpose: "step",
    ...overrides,
  };
}

function setup(options: { key?: string | null; events?: ProviderStreamEvent[]; failAfter?: number; reserve?: boolean; model?: ModelInfo | null } = {}) {
  const calls: StreamChatRequest[] = [];
  const ledger: string[] = [];
  const settled: unknown[] = [];
  const budget: MissionController["budget"] = {
    reserve: (missionId, estimate) => {
      ledger.push(`reserve ${missionId} ${String(estimate)}`);
      return options.reserve === false ? { ok: false, code: "budget", message: "budget de la mission atteint" } : { ok: true, reservationId: "r1" };
    },
    settle: (_missionId, reservationId, report) => {
      ledger.push(`settle ${reservationId}`);
      settled.push(report);
    },
    release: (_missionId, reservationId) => ledger.push(`release ${reservationId}`),
  };
  const events = options.events ?? [
    { type: "meta", servedModel: "acme/tools", servedProvider: "P", generationId: "g" },
    { type: "tool_call_delta", index: 0, id: "c2", name: "glob", argumentsDelta: "{}" },
    { type: "usage", usage: { promptTokens: 10, completionTokens: 2, reasoningTokens: null, cachedTokens: null, cost: 0.0004 } },
    { type: "finish", finishReason: "tool_calls" },
  ];
  const host = createProviderProxyHost({
    provider: {
      async *streamChat(apiKey, chat) {
        expect(apiKey).toBe(KEY);
        calls.push(chat);
        for (const [index, event] of events.entries()) {
          if (options.failAfter === index) throw new ProviderError(providerErrorInfo("rate_limited", { httpStatus: 429 }));
          yield event;
        }
      },
    },
    resolveApiKey: async () => (options.key === undefined ? KEY : options.key),
    dataCollection: () => "deny",
    model: () => (options.model === undefined ? MODEL : options.model),
    budget,
  });
  return { host, calls, ledger, settled };
}

async function collect(host: ReturnType<typeof setup>["host"], req = request()) {
  const events: ProxyStreamEvent[] = [];
  await host.streamModel(req, new AbortController().signal, (event) => events.push(event));
  return events;
}

describe("provider proxy host", () => {
  it("reserves the estimate, streams with tools resent and reasoning kept, then settles with the reported cost", async () => {
    const { host, calls, ledger, settled } = setup();
    const events = await collect(host);
    expect(events.map((event) => event.type)).toEqual(["meta", "tool_call_delta", "usage", "finish"]);
    expect(events.at(-1)).toEqual({ type: "finish", reason: "tool_calls" });
    expect(ledger[0]).toMatch(/^reserve 33333333-3333-4333-8333-333333333333 0\.00\d+$/);
    expect(ledger[1]).toBe("settle r1");
    expect(settled[0]).toMatchObject({ modelId: "acme/tools", servedModel: "acme/tools", usage: { cost: 0.0004 } });
    expect(calls[0]).toMatchObject({
      modelId: "acme/tools",
      dataCollection: "deny",
      maxTokens: 1_000,
      keepReasoningDetails: true,
      tools: [{ name: "read_file", description: "read", parameters: { type: "object" } }],
    });
    expect(calls[0]?.messages.slice(2)).toEqual([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: "{}" }], reasoningDetails: [{ type: "reasoning.encrypted", data: "x" }] },
      { role: "tool", toolCallId: "c1", content: "r" },
    ]);
  });

  it("refuses before any call without a key, without tool support, or over budget", async () => {
    const noKey = setup({ key: null });
    await expect(collect(noKey.host)).rejects.toMatchObject({ code: "no_key" });
    expect(noKey.ledger).toEqual([]);

    const noTools = setup({ model: { ...MODEL, supportsTools: false } });
    await expect(collect(noTools.host)).rejects.toMatchObject({ code: "no_tool_support" });
    expect(noTools.calls).toEqual([]);

    const broke = setup({ reserve: false });
    await expect(collect(broke.host)).rejects.toMatchObject({ code: "budget", message: "budget de la mission atteint" });
    expect(broke.calls).toEqual([]);
  });

  it("reserves nothing up front when the price is unknown", async () => {
    const { host, ledger } = setup({ model: null });
    await collect(host);
    expect(ledger[0]).toBe(`reserve ${MISSION} null`);
  });

  it("keeps provider error codes; releases when nothing was received, settles otherwise", async () => {
    const early = setup({ failAfter: 0 });
    await expect(collect(early.host)).rejects.toMatchObject({ code: "rate_limited", retryable: true });
    expect(early.ledger).toEqual([`reserve ${MISSION} ${String(early.ledger[0]?.split(" ")[2])}`, "release r1"]);

    const late = setup({ failAfter: 2 });
    await expect(collect(late.host)).rejects.toMatchObject({ code: "rate_limited" });
    expect(late.ledger.at(-1)).toBe("settle r1");
  });

  it("serves the same path as an in-process pull stream", async () => {
    const { host } = setup();
    const events: string[] = [];
    for await (const event of host.proxy.stream(request(), new AbortController().signal)) events.push(event.type);
    expect(events).toEqual(["meta", "tool_call_delta", "usage", "finish"]);
    const failing = setup({ failAfter: 1 });
    const seen: string[] = [];
    await expect(
      (async () => {
        for await (const event of failing.host.proxy.stream(request(), new AbortController().signal)) seen.push(event.type);
      })(),
    ).rejects.toMatchObject({ code: "rate_limited" });
    expect(seen).toEqual(["meta"]);
  });
});
