import { describe, expect, it } from "vitest";
import { recordingFetch, scriptedStream, splitBytes, sseData, sseResponse } from "./__fixtures__/fake-fetch";
import { OpenRouterProvider, buildChatBody } from "./openrouter";
import { ToolCallAssembler, mergeReasoningDetails } from "./tool-calls";
import type { ProviderStreamEvent, StreamChatRequest } from "./types";

const KEY = "sk-or-v1-0123456789abcdef0123456789abcdef";
const MODEL = "acme/tool-model";

function chunk(delta: Record<string, unknown>, finish: string | null = null): Record<string, unknown> {
  return { id: "gen-1", model: MODEL, provider: "P", choices: [{ index: 0, delta, finish_reason: finish }] };
}

const READ_TOOL = {
  name: "read_file",
  description: "Read a file",
  parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
};

function request(overrides: Partial<StreamChatRequest> = {}): StreamChatRequest {
  return {
    modelId: MODEL,
    messages: [{ role: "user", content: "lis a.ts" }],
    signal: new AbortController().signal,
    dataCollection: "deny",
    ...overrides,
  };
}

async function collect(transcript: string, size: number, overrides: Partial<StreamChatRequest> = {}) {
  const source = scriptedStream(splitBytes(transcript, size));
  const recorder = recordingFetch(() => sseResponse(source.stream));
  const provider = new OpenRouterProvider({ fetch: recorder.fetch });
  const events: ProviderStreamEvent[] = [];
  for await (const event of provider.streamChat(KEY, request(overrides))) events.push(event);
  return { events, calls: recorder.calls };
}

function assemble(events: ProviderStreamEvent[]) {
  const assembler = new ToolCallAssembler();
  for (const event of events) if (event.type === "tool_call_delta") assembler.push(event);
  return assembler.finish();
}

// Two parallel calls whose argument JSON is split mid-string, mid-escape and mid-character.
const PARALLEL_TRANSCRIPT = sseData(
  chunk({
    role: "assistant",
    content: null,
    tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "read_file", arguments: "" } }],
  }),
  chunk({ tool_calls: [{ index: 0, function: { arguments: '{"pa' } }] }),
  chunk({
    tool_calls: [{ index: 1, id: "call_b", type: "function", function: { name: "search_text", arguments: '{"pattern":"caf' } }],
  }),
  chunk({ tool_calls: [{ index: 0, function: { arguments: 'th":"src/a\\".ts"}' } }] }),
  chunk({ tool_calls: [{ index: 1, function: { arguments: 'é 🚀"}' } }] }),
  chunk({}, "tool_calls"),
  { id: "gen-1", choices: [], usage: { prompt_tokens: 10, completion_tokens: 4, cost: 0.001 } },
  "[DONE]",
);

describe("OpenRouter tool calling", () => {
  it.each([1, 3, 1 << 16])("assembles parallel calls from split fragments (%i-byte chunks)", async (size) => {
    const { events } = await collect(PARALLEL_TRANSCRIPT, size);
    expect(events.at(-1)).toEqual({ type: "finish", finishReason: "tool_calls" });
    expect(events.some((event) => event.type === "usage")).toBe(true);
    expect(assemble(events)).toEqual([
      { id: "call_a", name: "read_file", arguments: '{"path":"src/a\\".ts"}', overflow: false },
      { id: "call_b", name: "search_text", arguments: '{"pattern":"café 🚀"}', overflow: false },
    ]);
  });

  it("sends tools, tool choice, parallel flag, tool messages and reasoning details on the wire", async () => {
    const { calls } = await collect(sseData(chunk({ content: "ok" }, "stop"), "[DONE]"), 1 << 16, {
      tools: [READ_TOOL],
      toolChoice: "auto",
      parallelToolCalls: true,
      messages: [
        { role: "system", content: "s" },
        { role: "user", content: "u" },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "call_a", name: "read_file", arguments: '{"path":"a"}' }],
          reasoningDetails: [{ type: "reasoning.encrypted", data: "opaque" }],
        },
        { role: "tool", toolCallId: "call_a", content: "contenu" },
      ],
    });
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect(body.tools).toEqual([{ type: "function", function: READ_TOOL }]);
    expect(body.tool_choice).toBe("auto");
    expect(body.parallel_tool_calls).toBe(true);
    expect(body.messages).toEqual([
      { role: "system", content: "s" },
      { role: "user", content: "u" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "call_a", type: "function", function: { name: "read_file", arguments: '{"path":"a"}' } }],
        reasoning_details: [{ type: "reasoning.encrypted", data: "opaque" }],
      },
      { role: "tool", tool_call_id: "call_a", content: "contenu" },
    ]);
  });

  it("builds the web plugin, fallbacks and a forced tool choice", () => {
    const body = buildChatBody({
      modelId: MODEL,
      messages: [],
      dataCollection: "deny",
      tools: [READ_TOOL],
      toolChoice: { name: "read_file" },
      webPlugin: { maxResults: 3, includeDomains: ["developer.mozilla.org"], excludeDomains: [] },
      fallbackModelIds: [MODEL, "acme/backup"],
    });
    expect(body.tool_choice).toEqual({ type: "function", function: { name: "read_file" } });
    expect(body.plugins).toEqual([{ id: "web", max_results: 3, include_domains: ["developer.mozilla.org"] }]);
    expect(body.models).toEqual([MODEL, "acme/backup"]);
    const plain = buildChatBody({ modelId: MODEL, messages: [], dataCollection: "deny", tools: [] });
    expect(plain).not.toHaveProperty("tools");
    expect(plain).not.toHaveProperty("plugins");
    expect(plain).not.toHaveProperty("models");
  });

  it("reports url citations from annotations", async () => {
    const { events } = await collect(
      sseData(
        chunk({
          content: "Voir MDN.",
          annotations: [
            { type: "url_citation", url_citation: { url: "https://developer.mozilla.org/x", title: "MDN", content: "extrait" } },
            { type: "file", file: {} },
          ],
        }),
        chunk({}, "stop"),
        "[DONE]",
      ),
      1 << 16,
    );
    expect(events.filter((event) => event.type === "citation")).toEqual([
      { type: "citation", url: "https://developer.mozilla.org/x", title: "MDN", snippet: "extrait" },
    ]);
  });

  it("emits reasoning details only when asked, and merges streamed pieces", async () => {
    const transcript = sseData(
      chunk({ reasoning_details: [{ type: "reasoning.text", index: 0, text: "Je " }] }),
      chunk({ reasoning_details: [{ type: "reasoning.text", index: 0, text: "réfléchis", signature: "sig" }] }),
      chunk({ content: "ok" }, "stop"),
      "[DONE]",
    );
    const off = await collect(transcript, 1 << 16);
    expect(off.events.some((event) => event.type === "reasoning_details")).toBe(false);
    const on = await collect(transcript, 1 << 16, { keepReasoningDetails: true });
    const pieces = on.events.flatMap((event) => (event.type === "reasoning_details" ? event.details : []));
    expect(mergeReasoningDetails(pieces)).toEqual([
      { type: "reasoning.text", index: 0, text: "Je réfléchis", signature: "sig" },
    ]);
  });
});

describe("ToolCallAssembler", () => {
  it("drops nameless calls, synthesizes missing ids and flags oversized arguments", () => {
    const assembler = new ToolCallAssembler();
    assembler.push({ type: "tool_call_delta", index: 0, id: null, name: "glob", argumentsDelta: "{}" });
    assembler.push({ type: "tool_call_delta", index: 1, id: "x", name: null, argumentsDelta: "{}" });
    assembler.push({ type: "tool_call_delta", index: 2, id: "y", name: "read_file", argumentsDelta: "x".repeat(1_000_001) });
    expect(assembler.finish()).toEqual([
      { id: "call_0", name: "glob", arguments: "{}", overflow: false },
      { id: "y", name: "read_file", arguments: "", overflow: true },
    ]);
  });
});
