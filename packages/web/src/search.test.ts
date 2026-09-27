import { readFileSync } from "node:fs";
import type { ModelInfo } from "@nova/shared";
import { describe, expect, it } from "vitest";
import { buildWebPlugin, createOpenRouterWebSearcher, parseWebSearchCompletion, pickWebSearchModel, type SearchFetch } from "./search";

const fixture: unknown = JSON.parse(readFileSync(new URL("./__fixtures__/openrouter-web-search.json", import.meta.url), "utf8"));

function model(id: string, patch: Partial<ModelInfo> = {}): ModelInfo {
  return {
    id,
    name: id,
    author: id.split("/")[0] ?? id,
    description: null,
    contextLength: 128_000,
    maxCompletionTokens: null,
    inputModalities: ["text"],
    outputModalities: ["text"],
    supportsTools: true,
    supportsStructuredOutputs: null,
    supportsReasoning: null,
    pricing: { promptPerMTok: 1, completionPerMTok: 2, variable: false },
    isFree: false,
    expirationDate: null,
    createdAt: null,
    ...patch,
  };
}

describe("parseWebSearchCompletion", () => {
  it("builds citations from url_citation annotations only (deduplicated, http(s) only)", () => {
    const result = parseWebSearchCompletion("formater des euros", fixture, { modelId: "example/cheap-model", engine: "auto" });
    expect(result.citations.map((c) => c.url)).toEqual([
      "https://developer.mozilla.org/fr/docs/Web/JavaScript/Reference/Global_Objects/Intl/NumberFormat",
      "https://tc39.es/ecma402/#numberformat-objects",
    ]);
    // A URL present only in the text is never a citation.
    expect(result.citations.some((c) => c.url.includes("invented.example.org"))).toBe(false);
    expect(result.citations[0]).toMatchObject({ title: "Intl.NumberFormat - JavaScript | MDN" });
    expect(result).toMatchObject({
      query: "formater des euros",
      costUsd: 0.0081,
      engine: "auto",
      modelId: "example/cheap-model",
      servedModel: "example/cheap-model-2026",
      servedProvider: "ExampleProvider",
    });
    expect(result.usage).toMatchObject({ promptTokens: 3120, completionTokens: 64, cost: 0.0081 });
    expect(result.answer).toContain("Intl.NumberFormat");
  });

  it("keeps cost unknown when usage has no cost", () => {
    const payload = { choices: [{ message: { content: "ok", annotations: [] } }], usage: { prompt_tokens: 10 } };
    expect(parseWebSearchCompletion("q", payload, { modelId: "m", engine: "auto" })).toMatchObject({ costUsd: null, citations: [] });
  });

  it("maps an error body to search_failed", () => {
    expect(() => parseWebSearchCompletion("q", { error: { message: "rate limited" } }, { modelId: "m", engine: "auto" })).toThrow(
      expect.objectContaining({ code: "search_failed" }),
    );
  });
});

describe("pickWebSearchModel", () => {
  it("chooses the cheapest tools-capable, fixed-price, paid text model", () => {
    const models = [
      model("a/expensive", { pricing: { promptPerMTok: 3, completionPerMTok: 15, variable: false } }),
      model("b/cheap", { pricing: { promptPerMTok: 0.1, completionPerMTok: 0.4, variable: false } }),
      model("c/no-tools", { supportsTools: false, pricing: { promptPerMTok: 0.01, completionPerMTok: 0.01, variable: false } }),
      model("d/free", { isFree: true, pricing: { promptPerMTok: 0, completionPerMTok: 0, variable: false } }),
      model("e/router", { pricing: { promptPerMTok: 0.01, completionPerMTok: 0.01, variable: true } }),
      model("f/unknown", { pricing: { promptPerMTok: null, completionPerMTok: 0.01, variable: false } }),
      model("g/image", { outputModalities: ["image"], pricing: { promptPerMTok: 0.01, completionPerMTok: 0.01, variable: false } }),
    ];
    expect(pickWebSearchModel(models)?.id).toBe("b/cheap");
    expect(pickWebSearchModel([models[2] as ModelInfo])).toBeNull();
  });
});

describe("buildWebPlugin", () => {
  it("passes policy filters and bounds max_results", () => {
    expect(buildWebPlugin({ maxResults: 50, filters: { includeDomains: ["mozilla.org"], excludeDomains: ["evil.net"] } })).toEqual({
      id: "web",
      max_results: 20,
      include_domains: ["mozilla.org"],
      exclude_domains: ["evil.net"],
    });
    expect(buildWebPlugin({ maxResults: 3, filters: { includeDomains: [], excludeDomains: [] }, engine: "exa" })).toEqual({
      id: "web",
      max_results: 3,
      engine: "exa",
    });
  });
});

describe("createOpenRouterWebSearcher", () => {
  it("sends one non-streaming completion with the web plugin and never leaks the key in errors", async () => {
    const calls: { url: string; body: unknown; auth: string | null }[] = [];
    const okFetch: SearchFetch = async (url, init) => {
      calls.push({ url, body: JSON.parse(String(init.body)), auth: new Headers(init.headers).get("authorization") });
      return new Response(JSON.stringify(fixture), { status: 200 });
    };
    const searcher = createOpenRouterWebSearcher({
      apiKey: async () => "sk-or-v1-secretsecretsecret",
      selectModel: async () => "example/cheap-model",
      dataCollection: () => "deny",
      fetch: okFetch,
      baseUrl: "https://openrouter.test/api/v1",
    });
    const result = await searcher.search({
      query: "  euros  ",
      plugin: { maxResults: 5, filters: { includeDomains: [], excludeDomains: ["evil.net"] } },
      signal: new AbortController().signal,
    });
    expect(result.citations).toHaveLength(2);
    expect(calls[0]?.url).toBe("https://openrouter.test/api/v1/chat/completions");
    expect(calls[0]?.body).toMatchObject({
      model: "example/cheap-model",
      stream: false,
      plugins: [{ id: "web", max_results: 5, exclude_domains: ["evil.net"] }],
      provider: { data_collection: "deny" },
    });

    const failing = createOpenRouterWebSearcher({
      apiKey: async () => "weird-key-format-123456",
      selectModel: async () => "example/cheap-model",
      dataCollection: () => "deny",
      fetch: async () => new Response("bad key weird-key-format-123456", { status: 401 }),
    });
    const error = await failing
      .search({ query: "q", plugin: { maxResults: 1, filters: { includeDomains: [], excludeDomains: [] } }, signal: new AbortController().signal })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "search_failed", status: 401 });
    expect(String((error as Error).message)).not.toContain("weird-key-format-123456");
  });

  it("is unavailable without a key or without a usable model", async () => {
    const plugin = { maxResults: 1, filters: { includeDomains: [], excludeDomains: [] } };
    const noKey = createOpenRouterWebSearcher({ apiKey: async () => null, selectModel: async () => "m", dataCollection: () => "deny" });
    await expect(noKey.search({ query: "q", plugin, signal: new AbortController().signal })).rejects.toMatchObject({ code: "search_unavailable" });
    const noModel = createOpenRouterWebSearcher({ apiKey: async () => "sk-x", selectModel: async () => null, dataCollection: () => "deny" });
    await expect(noModel.search({ query: "q", plugin, signal: new AbortController().signal })).rejects.toMatchObject({ code: "search_unavailable" });
  });
});
