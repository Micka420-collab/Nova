import type { ProviderErrorCode } from "@nova/shared";
import { describe, expect, it } from "vitest";
import {
  jsonResponse,
  pendingUntilAborted,
  recordingFetch,
  scriptedStream,
  splitBytes,
  sseData,
  sseResponse,
  type RecordedRequest,
  type StreamStep,
} from "./__fixtures__/fake-fetch";
import fixture from "./__fixtures__/openrouter-models.json";
import { OpenRouterProvider } from "./openrouter";
import { ProviderError, type ProviderStreamEvent, type StreamChatRequest } from "./types";

const KEY = "sk-or-v1-0123456789abcdef0123456789abcdef";
const KEEP_ALIVE = ": OPENROUTER PROCESSING\n\n";
const MODEL = "deepseek/deepseek-v4-flash";

function chunk(delta: Record<string, unknown>, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "gen-123",
    model: MODEL,
    provider: "DeepInfra",
    choices: [{ index: 0, delta, finish_reason: null }],
    ...extra,
  };
}

const USAGE = {
  prompt_tokens: 12,
  completion_tokens: 5,
  total_tokens: 17,
  cost: 0.0000021,
  prompt_tokens_details: { cached_tokens: 4 },
  completion_tokens_details: { reasoning_tokens: 2 },
};

function request(overrides: Partial<StreamChatRequest> = {}): StreamChatRequest {
  return {
    modelId: MODEL,
    messages: [{ role: "user", content: "Bonjour" }],
    signal: new AbortController().signal,
    dataCollection: "deny",
    ...overrides,
  };
}

interface Outcome {
  events: ProviderStreamEvent[];
  error: ProviderError | null;
}

async function run(stream: AsyncIterable<ProviderStreamEvent>, key = KEY): Promise<Outcome> {
  const events: ProviderStreamEvent[] = [];
  try {
    for await (const event of stream) events.push(event);
    return { events, error: null };
  } catch (error) {
    if (!(error instanceof ProviderError)) throw error;
    expectNoSecret(error, key);
    return { events, error };
  }
}

/** Every failure must be safe to log, store and display. */
function expectNoSecret(error: ProviderError, key: string): void {
  expect(`${error.message} ${error.stack ?? ""} ${JSON.stringify(error.info)}`).not.toContain(key);
}

function providerFor(steps: StreamStep[], options: { hang?: boolean; timeouts?: { requestMs?: number; idleMs?: number } } = {}) {
  const source = scriptedStream(steps, { hang: options.hang ?? false });
  const recorder = recordingFetch(() => sseResponse(source.stream));
  const provider = new OpenRouterProvider({ fetch: recorder.fetch, timeouts: options.timeouts ?? {} });
  return { provider, source, calls: recorder.calls };
}

function headersOf(call: RecordedRequest | undefined): Headers {
  return new Headers(call?.init.headers);
}

const COMPLETE_STREAM =
  KEEP_ALIVE +
  sseData(chunk({ role: "assistant", content: "Bonjour, " })) +
  KEEP_ALIVE +
  sseData(
    chunk({ content: "café 🚀 prêt" }),
    chunk({ content: "" }, { choices: [{ index: 0, delta: { content: "" }, finish_reason: "stop" }], usage: USAGE }),
    chunk({}, { choices: [], usage: { ...USAGE, cost: 0.0000025 } }),
    "[DONE]",
  );

describe("OpenRouterProvider.streamChat", () => {
  it.each([
    ["LF, 1-byte chunks", COMPLETE_STREAM, 1],
    ["LF, 7-byte chunks", COMPLETE_STREAM, 7],
    ["CRLF, 5-byte chunks", COMPLETE_STREAM.replaceAll("\n", "\r\n"), 5],
    ["LF, single chunk", COMPLETE_STREAM, 1 << 16],
  ])("streams a complete generation (%s)", async (_label, transcript, size) => {
    const { provider } = providerFor(splitBytes(transcript, size));
    const { events, error } = await run(provider.streamChat(KEY, request()));
    expect(error).toBeNull();
    const usage = { promptTokens: 12, completionTokens: 5, reasoningTokens: 2, cachedTokens: 4 };
    expect(events).toEqual([
      { type: "meta", servedModel: MODEL, servedProvider: "DeepInfra", generationId: "gen-123" },
      { type: "text", text: "Bonjour, " },
      { type: "text", text: "café 🚀 prêt" },
      { type: "usage", usage: { ...usage, cost: 0.0000021 } },
      { type: "usage", usage: { ...usage, cost: 0.0000025 } },
      { type: "finish", finishReason: "stop" },
    ]);
  });

  it("sends the chat request with privacy routing, streaming and attribution headers", async () => {
    const { provider, calls } = providerFor([sseData(chunk({ content: "ok" }), "[DONE]")]);
    await run(provider.streamChat(KEY, request({ dataCollection: "deny", maxTokens: 16 })));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(calls[0]?.init.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      model: MODEL,
      messages: [{ role: "user", content: "Bonjour" }],
      stream: true,
      provider: { data_collection: "deny" },
      max_tokens: 16,
    });
    const headers = headersOf(calls[0]);
    expect(headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(headers.get("http-referer")).toBe("https://github.com/Micka420-collab/Nova");
    expect(headers.get("x-openrouter-title")).toBe("NOVA");
    expect(headers.get("content-type")).toBe("application/json");
  });

  it("J2-B L7: sends the reasoning effort only when asked, never the reasoning itself", async () => {
    const { provider, calls } = providerFor([sseData(chunk({ content: "ok" }), "[DONE]")]);
    await run(provider.streamChat(KEY, request({ reasoningEffort: "high" })));
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect(body.reasoning).toEqual({ effort: "high" });
    const plain = providerFor([sseData(chunk({ content: "ok" }), "[DONE]")]);
    await run(plain.provider.streamChat(KEY, request()));
    expect(JSON.parse(String(plain.calls[0]?.init.body))).not.toHaveProperty("reasoning");
  });

  it("J2-B L7: sends pasted images as data-URL parts of the user turn (text first)", async () => {
    const { provider, calls } = providerFor([sseData(chunk({ content: "ok" }), "[DONE]")]);
    const messages: StreamChatRequest["messages"] = [
      { role: "system", content: "Sois bref." },
      { role: "user", content: "Que montre cette capture ?", images: [{ mediaType: "image/png", dataBase64: "iVBORw0KGgo=" }] },
      { role: "user", content: "Sans image", images: [] },
    ];
    await run(provider.streamChat(KEY, request({ messages })));
    const body = JSON.parse(String(calls[0]?.init.body)) as { messages: unknown[] };
    expect(body.messages).toEqual([
      { role: "system", content: "Sois bref." },
      {
        role: "user",
        content: [
          { type: "text", text: "Que montre cette capture ?" },
          { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } },
        ],
      },
      { role: "user", content: "Sans image" },
    ]);
  });

  it("omits max_tokens when not requested and forwards data_collection allow", async () => {
    const { provider, calls } = providerFor([sseData(chunk({ content: "ok" }), "[DONE]")]);
    await run(provider.streamChat(KEY, request({ dataCollection: "allow" })));
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect(body.provider).toEqual({ data_collection: "allow" });
    expect(body).not.toHaveProperty("max_tokens");
  });

  it("reports reasoning activity without exposing the reasoning content", async () => {
    const secretThought = "pensée interne à ne pas afficher";
    const { provider } = providerFor([
      sseData(
        chunk({ content: "", reasoning: secretThought, reasoning_details: [{ type: "reasoning.text", text: secretThought }] }),
        chunk({ content: null, reasoning: null, reasoning_details: [{ type: "reasoning.encrypted", data: "xyz" }] }),
        chunk({ content: "", reasoning: "", reasoning_details: [] }),
        chunk({ content: "ok" }, { choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] }),
        "[DONE]",
      ),
    ]);
    const { events, error } = await run(provider.streamChat(KEY, request()));
    expect(error).toBeNull();
    expect(events.map((event) => event.type)).toEqual(["meta", "reasoning", "reasoning", "text", "finish"]);
    expect(JSON.stringify(events)).not.toContain(secretThought);
  });

  it("fails on a mid-stream error chunk after HTTP 200 and yields nothing after it", async () => {
    const { provider, source } = providerFor([
      sseData(
        chunk({ content: "Début" }),
        chunk(
          { content: "" },
          {
            error: { code: 502, message: "Provider disconnected", metadata: { error_type: "provider_unavailable" } },
            choices: [{ index: 0, delta: { content: "" }, finish_reason: "error" }],
          },
        ),
        chunk({ content: "jamais vu" }),
        "[DONE]",
      ),
    ]);
    const { events, error } = await run(provider.streamChat(KEY, request()));
    expect(events.map((event) => event.type)).toEqual(["meta", "text"]);
    expect(error?.info).toEqual({
      code: "model_unavailable",
      httpStatus: 502,
      retryAfterSec: null,
      providerMessage: "Provider disconnected (provider_unavailable)",
      retryable: true,
    });
    expect(source.cancelled).toBe(true);
  });

  it("treats finish_reason error without an error object as a failure", async () => {
    const { provider } = providerFor([
      sseData(chunk({ content: "" }, { choices: [{ index: 0, delta: {}, finish_reason: "error" }] }), "[DONE]"),
    ]);
    const { error } = await run(provider.streamChat(KEY, request()));
    expect(error?.info.code).toBe("provider_error");
  });

  it("fails with stream_interrupted when the stream ends without [DONE] nor finish_reason", async () => {
    const { provider } = providerFor([sseData(chunk({ content: "Début" }))]);
    const { events, error } = await run(provider.streamChat(KEY, request()));
    expect(events.map((event) => event.type)).toEqual(["meta", "text"]);
    expect(error?.info).toMatchObject({ code: "stream_interrupted", retryable: true });
  });

  it("accepts a stream that reported finish_reason but lost the [DONE] terminator", async () => {
    const { provider } = providerFor([
      sseData(chunk({ content: "ok" }, { choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "length" }] })),
    ]);
    const { events, error } = await run(provider.streamChat(KEY, request()));
    expect(error).toBeNull();
    expect(events.at(-1)).toEqual({ type: "finish", finishReason: "length" });
  });

  it("rejects a non-JSON data payload", async () => {
    const { provider } = providerFor(["data: {not json\n\n"]);
    const { error } = await run(provider.streamChat(KEY, request()));
    expect(error?.info.code).toBe("provider_error");
  });

  it("aborts mid-stream on user cancel, reports aborted and releases the body", async () => {
    const controller = new AbortController();
    const { provider, source } = providerFor([sseData(chunk({ content: "Début" }))], { hang: true });
    const events: ProviderStreamEvent[] = [];
    let caught: unknown = null;
    try {
      for await (const event of provider.streamChat(KEY, request({ signal: controller.signal }))) {
        events.push(event);
        if (event.type === "text") setTimeout(() => controller.abort(), 5);
      }
    } catch (error) {
      caught = error;
    }
    expect(events.map((event) => event.type)).toEqual(["meta", "text"]);
    expect(caught).toBeInstanceOf(ProviderError);
    expect((caught as ProviderError).info).toMatchObject({ code: "aborted", retryable: false });
    expect(source.cancelled).toBe(true);
  });

  it("aborts while waiting for headers and never fetches when already aborted", async () => {
    const controller = new AbortController();
    const waiting = recordingFetch(({ init }) => pendingUntilAborted(init));
    const provider = new OpenRouterProvider({ fetch: waiting.fetch });
    const pending = run(provider.streamChat(KEY, request({ signal: controller.signal })));
    setTimeout(() => controller.abort(), 5);
    expect((await pending).error?.info.code).toBe("aborted");

    const idle = recordingFetch(() => jsonResponse(200, {}));
    const aborted = new AbortController();
    aborted.abort();
    const outcome = await run(new OpenRouterProvider({ fetch: idle.fetch }).streamChat(KEY, request({ signal: aborted.signal })));
    expect(outcome.error?.info.code).toBe("aborted");
    expect(idle.calls).toHaveLength(0);
  });

  it("releases the body when the consumer stops early", async () => {
    const { provider, source } = providerFor([sseData(chunk({ content: "a" }), chunk({ content: "b" }))], { hang: true });
    for await (const event of provider.streamChat(KEY, request())) {
      if (event.type === "text") break;
    }
    expect(source.cancelled).toBe(true);
  });

  it("times out when no response headers arrive in time", async () => {
    const waiting = recordingFetch(({ init }) => pendingUntilAborted(init));
    const provider = new OpenRouterProvider({ fetch: waiting.fetch, timeouts: { requestMs: 20 } });
    const { error } = await run(provider.streamChat(KEY, request()));
    expect(error?.info).toMatchObject({ code: "timeout", retryable: true, httpStatus: null });
  });

  it("times out when the stream goes silent, distinct from a user abort", async () => {
    const { provider, source } = providerFor([sseData(chunk({ content: "Début" }))], {
      hang: true,
      timeouts: { idleMs: 40 },
    });
    const { events, error } = await run(provider.streamChat(KEY, request()));
    expect(events.map((event) => event.type)).toEqual(["meta", "text"]);
    expect(error?.info).toMatchObject({ code: "timeout", retryable: true });
    expect(source.cancelled).toBe(true);
  });

  it("counts keep-alive comments as activity for the idle timeout", async () => {
    const keepAlives = Array.from({ length: 8 }, () => [25, KEEP_ALIVE]).flat();
    const { provider } = providerFor(
      [sseData(chunk({ content: "a" })), ...keepAlives, sseData(chunk({ content: "b" }), "[DONE]")],
      { timeouts: { idleMs: 100 } },
    );
    const { events, error } = await run(provider.streamChat(KEY, request()));
    expect(error).toBeNull();
    expect(events.filter((event) => event.type === "text")).toHaveLength(2);
  });

  it.each<[number, ProviderErrorCode, boolean]>([
    [400, "bad_request", false],
    [401, "invalid_key", false],
    // A 402 carrying Retry-After is OpenRouter's in-flight budget: wait, not top up.
    [402, "rate_limited", true],
    [403, "forbidden", false],
    [404, "not_found", false],
    [408, "timeout", true],
    [429, "rate_limited", true],
    [500, "provider_error", true],
    [502, "model_unavailable", true],
    [503, "no_provider", true],
  ])("maps HTTP %i to %s", async (status, code, retryable) => {
    const recorder = recordingFetch(() =>
      jsonResponse(status, { error: { code: status, message: `Erreur ${status}` } }, { "Retry-After": "12" }),
    );
    const { error } = await run(new OpenRouterProvider({ fetch: recorder.fetch }).streamChat(KEY, request()));
    expect(error?.info).toEqual({
      code,
      httpStatus: status,
      retryAfterSec: 12,
      providerMessage: `Erreur ${status}`,
      retryable,
    });
  });

  it("maps a rejected fetch to a retryable network error", async () => {
    const recorder = recordingFetch(() => {
      throw new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND openrouter.ai") });
    });
    const { error } = await run(new OpenRouterProvider({ fetch: recorder.fetch }).streamChat(KEY, request()));
    expect(error?.info).toMatchObject({ code: "network", retryable: true, httpStatus: null });
    expect(error?.info.providerMessage).toContain("ENOTFOUND");
  });

  it("fails a key no HTTP header can carry as a non-retryable bad request, without any I/O", async () => {
    const unusable = `${KEY}\u200b`;
    const recorder = recordingFetch(() => jsonResponse(401, { error: { code: 401, message: "no" } }));
    const provider = new OpenRouterProvider({ fetch: recorder.fetch });
    const { error } = await run(provider.streamChat(unusable, request()), unusable);
    expect(error?.info).toMatchObject({ code: "bad_request", retryable: false, httpStatus: null });
    const checked = await provider.checkKey(`${KEY}…`).catch((caught: unknown) => caught);
    expect(checked).toBeInstanceOf(ProviderError);
    expect((checked as ProviderError).info).toMatchObject({ code: "bad_request", retryable: false });
    expectNoSecret(checked as ProviderError, `${KEY}…`);
    expect(recorder.calls).toEqual([]);
  });

  it("never leaks a key of any shape through errors", async () => {
    const oddKey = "nova-test-key-ZXCVBNMASDFGHJKL";
    const echoing = recordingFetch(({ init }) => {
      const auth = new Headers(init.headers).get("authorization") ?? "";
      return jsonResponse(401, { error: { code: 401, message: `Rejected ${auth} (${auth.slice(7)})` } });
    });
    const httpOutcome = await run(new OpenRouterProvider({ fetch: echoing.fetch }).streamChat(oddKey, request()), oddKey);
    expect(httpOutcome.error?.info.code).toBe("invalid_key");

    const throwing = recordingFetch(() => {
      throw new TypeError(`Headers.append: "Bearer ${oddKey}\n" is an invalid header value.`);
    });
    const networkOutcome = await run(
      new OpenRouterProvider({ fetch: throwing.fetch }).streamChat(oddKey, request()),
      oddKey,
    );
    expect(networkOutcome.error?.info.code).toBe("network");
  });
});

describe("OpenRouterProvider.listModels", () => {
  it("normalizes the live catalog shape, skips invalid entries and duplicates", async () => {
    const recorder = recordingFetch(() =>
      jsonResponse(200, { data: [...fixture.data, { id: 42 }, null, { name: "sans id" }, fixture.data[1]] }),
    );
    const models = await new OpenRouterProvider({ fetch: recorder.fetch }).listModels();
    expect(models.map((model) => model.id)).toEqual(fixture.data.map((entry) => entry.id));
    expect(recorder.calls[0]?.url).toBe("https://openrouter.ai/api/v1/models");
    expect(headersOf(recorder.calls[0]).has("authorization")).toBe(false);
  });

  it("authenticates when a key is given and fails on an unexpected body", async () => {
    const recorder = recordingFetch(() => jsonResponse(200, { models: [] }));
    const provider = new OpenRouterProvider({ fetch: recorder.fetch, baseUrl: "https://example.test/api/v1/" });
    await expect(provider.listModels({ apiKey: KEY })).rejects.toMatchObject({ info: { code: "provider_error" } });
    expect(recorder.calls[0]?.url).toBe("https://example.test/api/v1/models");
    expect(headersOf(recorder.calls[0]).get("authorization")).toBe(`Bearer ${KEY}`);
  });
});

describe("OpenRouterProvider.checkKey", () => {
  it("maps the key limits", async () => {
    const recorder = recordingFetch(() =>
      jsonResponse(200, {
        data: {
          label: "Nova perso",
          limit: 10,
          limit_reset: "monthly",
          limit_remaining: 7.5,
          usage: 2.5,
          usage_daily: 0.1,
          is_free_tier: false,
          free_model_daily_requests: { limit: 1000 },
        },
      }),
    );
    const result = await new OpenRouterProvider({ fetch: recorder.fetch }).checkKey(KEY);
    expect(result).toEqual({ label: "Nova perso", limit: 10, limitRemaining: 7.5, usage: 2.5, isFreeTier: false });
    expect(recorder.calls[0]?.url).toBe("https://openrouter.ai/api/v1/key");
    expect(headersOf(recorder.calls[0]).get("authorization")).toBe(`Bearer ${KEY}`);
  });

  it("keeps unknown limits null and redacts a key-shaped label", async () => {
    const recorder = recordingFetch(() =>
      jsonResponse(200, { data: { label: "sk-or-v1-0123456789abc...def", limit: null, limit_remaining: null } }),
    );
    const result = await new OpenRouterProvider({ fetch: recorder.fetch }).checkKey(KEY);
    expect(result).toEqual({ label: "[secret masqué]...def", limit: null, limitRemaining: null, usage: null, isFreeTier: null });
  });

  it("reports an invalid key as invalid_key with the provider message", async () => {
    const recorder = recordingFetch(() => jsonResponse(401, { error: { message: "User not found.", code: 401 } }));
    const error = await new OpenRouterProvider({ fetch: recorder.fetch }).checkKey(KEY).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).info).toEqual({
      code: "invalid_key",
      httpStatus: 401,
      retryAfterSec: null,
      providerMessage: "User not found.",
      retryable: false,
    });
    expectNoSecret(error as ProviderError, KEY);
  });
});
