// Live OpenRouter checks. Skipped unless NOVA_LIVE_OPENROUTER_KEY_FILE names a readable key file.
// Costs a few micro-dollars per run. The key is never printed.
import { readFileSync } from "node:fs";
import type { ModelInfo } from "@nova/shared";
import { describe, expect, it } from "vitest";
import { OpenRouterProvider } from "./openrouter";
import type { ProviderStreamEvent } from "./types";

function readLiveKey(): string | null {
  const file = process.env.NOVA_LIVE_OPENROUTER_KEY_FILE;
  if (!file) return null;
  try {
    const key = readFileSync(file, "utf8").trim();
    return key.length > 0 ? key : null;
  } catch {
    return null;
  }
}

const liveKey = readLiveKey();

/**
 * Cheapest priced deepseek text-in/text-out model of the live catalog (never a hard-coded id).
 * Free variants are skipped: their endpoints usually require data collection, which NOVA denies.
 */
function cheapestDeepseek(models: ModelInfo[]): ModelInfo | undefined {
  const priced = models.filter(
    (model) =>
      model.id.startsWith("deepseek/") &&
      !model.isFree &&
      model.inputModalities?.includes("text") === true &&
      model.outputModalities?.includes("text") === true &&
      !model.pricing.variable &&
      model.pricing.promptPerMTok !== null &&
      model.pricing.completionPerMTok !== null,
  );
  const total = (model: ModelInfo): number =>
    (model.pricing.promptPerMTok ?? 0) + (model.pricing.completionPerMTok ?? 0);
  return priced.sort((a, b) => total(a) - total(b))[0];
}

describe.skipIf(liveKey === null)("OpenRouter live", () => {
  const key = liveKey ?? "";
  const provider = new OpenRouterProvider();

  it("validates the key", async () => {
    const result = await provider.checkKey(key);
    expect(result).toHaveProperty("limitRemaining");
  });

  it("streams a tiny completion from the cheapest deepseek model", { timeout: 90_000 }, async () => {
    const models = await provider.listModels({ apiKey: key });
    expect(models.length).toBeGreaterThan(0);
    const model = cheapestDeepseek(models);
    expect(model, "no priced deepseek text model in the live catalog").toBeDefined();
    if (!model) return;

    const events: ProviderStreamEvent[] = [];
    const stream = provider.streamChat(key, {
      modelId: model.id,
      messages: [{ role: "user", content: "Réponds juste: ok" }],
      signal: AbortSignal.timeout(60_000),
      dataCollection: "deny",
      maxTokens: 16,
    });
    for await (const event of stream) events.push(event);

    const types = events.map((event) => event.type);
    expect(types[0]).toBe("meta");
    expect(types.at(-1)).toBe("finish");
    expect(types, `model ${model.id}`).toContain("text");
    expect(types).toContain("usage");
  });
});
