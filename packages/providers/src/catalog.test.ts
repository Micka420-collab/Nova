import type { ModelInfo } from "@nova/shared";
import { describe, expect, it } from "vitest";
import fixture from "./__fixtures__/openrouter-models.json";
import { normalizeOpenRouterModel } from "./catalog";

function modelsById(): Map<string, ModelInfo> {
  const models = fixture.data.map(normalizeOpenRouterModel);
  return new Map(models.flatMap((model) => (model ? [[model.id, model] as const] : [])));
}

describe("normalizeOpenRouterModel (captured catalog)", () => {
  const models = modelsById();

  it("normalizes every real entry", () => {
    expect(models.size).toBe(fixture.data.length);
  });

  it("maps a regular model: prices per million tokens, capabilities, limits and dates", () => {
    expect(models.get("deepseek/deepseek-v4.1-flash")).toEqual({
      id: "deepseek/deepseek-v4.1-flash",
      name: expect.any(String),
      author: "deepseek",
      description: expect.any(String),
      contextLength: 1048576,
      maxCompletionTokens: 384000,
      inputModalities: ["text", "image"],
      outputModalities: ["text"],
      supportsTools: true,
      supportsStructuredOutputs: true,
      supportsReasoning: true,
      pricing: { promptPerMTok: 0.035, completionPerMTok: 0.29, variable: false },
      isFree: false,
      expirationDate: null,
      createdAt: 1789021285000,
    });
  });

  it("marks routers with -1 pricing as variable with unknown prices and unknown capabilities", () => {
    expect(models.get("typesafe/jev-router")).toMatchObject({
      pricing: { promptPerMTok: null, completionPerMTok: null, variable: true },
      isFree: false,
      supportsTools: null,
      supportsStructuredOutputs: null,
      supportsReasoning: null,
      maxCompletionTokens: null,
    });
    expect(models.get("openrouter/auto-beta")?.pricing.variable).toBe(true);
  });

  it("keeps announced expiration dates", () => {
    expect(models.get("deepseek/deepseek-v3.2")?.expirationDate).toBe("2026-09-28");
    expect(models.get("bytedance-seed/seed-2.0-code")?.expirationDate).toBe("2026-11-11");
  });

  it("reports missing capabilities as false only when the parameter list is known", () => {
    expect(models.get("deepseek/deepseek-r1-distill-llama-70b")).toMatchObject({
      supportsTools: false,
      supportsStructuredOutputs: false,
      supportsReasoning: true,
    });
    expect(models.get("deepseek/deepseek-r1")?.supportsStructuredOutputs).toBe(true);
  });

  it("detects free models", () => {
    expect(models.get("inclusionai/ling-3.0-flash-sante:free")).toMatchObject({
      isFree: true,
      pricing: { promptPerMTok: 0, completionPerMTok: 0, variable: false },
    });
  });
});

describe("normalizeOpenRouterModel (malformed input)", () => {
  it.each([null, 42, "deepseek/x", [], {}, { id: 42 }, { id: "no-author" }, { id: "/model" }, { id: "a b/c" }])(
    "rejects %j",
    (raw) => {
      expect(normalizeOpenRouterModel(raw)).toBeNull();
    },
  );

  it("turns missing or invalid fields into null instead of guessing", () => {
    expect(
      normalizeOpenRouterModel({
        id: "acme/model",
        created: "yesterday",
        context_length: -5,
        pricing: { prompt: "abc", completion: null },
        architecture: { input_modalities: [] },
        expiration_date: "not a date",
      }),
    ).toEqual({
      id: "acme/model",
      name: "acme/model",
      author: "acme",
      description: null,
      contextLength: null,
      maxCompletionTokens: null,
      inputModalities: null,
      outputModalities: null,
      supportsTools: null,
      supportsStructuredOutputs: null,
      supportsReasoning: null,
      pricing: { promptPerMTok: null, completionPerMTok: null, variable: false },
      isFree: false,
      expirationDate: null,
      createdAt: null,
    });
  });

  it("free variants are free whatever their listed price", () => {
    expect(normalizeOpenRouterModel({ id: "acme/model:free" })?.isFree).toBe(true);
  });
});
