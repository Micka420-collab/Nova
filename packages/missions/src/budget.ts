// Mo5: cost estimates from catalog prices. Unknown prices stay unknown (null), never guessed.
import type { ToolDefinition } from "@nova/shared";
import { buildContextPlan } from "./context-plan";
import type { ProxyMessage } from "./index";

export interface PricingLike {
  /** USD per million prompt tokens; null = unknown. */
  promptPerMTok: number | null;
  completionPerMTok: number | null;
}

export interface CallEstimate {
  approxPromptTokens: number;
  maxCompletionTokens: number;
  /** Upper bound of the call (full prompt + every allowed output token); null when a price is unknown. */
  maxUsd: number | null;
}

export function estimateCallCost(input: {
  messages: readonly ProxyMessage[];
  tools: readonly ToolDefinition[];
  maxTokens: number;
  pricing: PricingLike | null;
}): CallEstimate {
  const plan = buildContextPlan({ messages: input.messages, tools: input.tools, modelId: "-", dataCollection: "deny" });
  const promptPrice = input.pricing?.promptPerMTok ?? null;
  const completionPrice = input.pricing?.completionPerMTok ?? null;
  const maxUsd =
    promptPrice === null || completionPrice === null
      ? null
      : (plan.approxPromptTokens * promptPrice + input.maxTokens * completionPrice) / 1_000_000;
  return { approxPromptTokens: plan.approxPromptTokens, maxCompletionTokens: input.maxTokens, maxUsd };
}

/**
 * Mission range for the contract sheet (A13): a few steps per task, each re-sending a growing
 * context. The assumptions travel with the numbers (French UI copy).
 */
export function estimateMission(input: {
  taskCount: number;
  basePromptTokens: number;
  pricing: PricingLike | null;
}): { minUsd: number | null; maxUsd: number | null; assumptions: string } {
  const tasks = Math.max(1, input.taskCount);
  const minSteps = tasks * 2;
  const maxSteps = tasks * 6;
  const promptPrice = input.pricing?.promptPerMTok ?? null;
  const completionPrice = input.pricing?.completionPerMTok ?? null;
  const assumptions =
    `≈ ${minSteps} à ${maxSteps} appels au modèle (${tasks} étape${tasks > 1 ? "s" : ""}), ` +
    `contexte de départ ≈ ${input.basePromptTokens} jetons qui grandit d'environ 2 000 jetons par appel, ` +
    "≈ 800 jetons produits par appel, prix du catalogue.";
  if (promptPrice === null || completionPrice === null) return { minUsd: null, maxUsd: null, assumptions };
  const cost = (steps: number): number => {
    let total = 0;
    for (let step = 0; step < steps; step += 1) {
      total += ((input.basePromptTokens + step * 2_000) * promptPrice + 800 * completionPrice) / 1_000_000;
    }
    return Math.round(total * 10_000) / 10_000;
  };
  return { minUsd: cost(minSteps), maxUsd: cost(maxSteps), assumptions };
}
