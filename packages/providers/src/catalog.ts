// Normalization of OpenRouter `GET /models` entries into the product's ModelInfo.
import type { ModelInfo, ModelPricing } from "@nova/shared";
import { asFiniteNumber, asRecord, asString, asStringArray } from "./coerce";

/** `author/model[:variant]`; the author prefix is required. */
const MODEL_ID = /^([^/\s]+)\/\S+$/;

/** OpenRouter's marker for variable pricing (routers). */
const VARIABLE_PRICE = -1;

type Price = { perMTok: number | null; variable: boolean };

/** Per-token USD string -> USD per million tokens, rounded to drop float noise. */
function parsePrice(value: unknown): Price {
  const perToken =
    typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
  if (perToken === VARIABLE_PRICE) return { perMTok: null, variable: true };
  if (!Number.isFinite(perToken) || perToken < 0) return { perMTok: null, variable: false };
  return { perMTok: Number((perToken * 1_000_000).toPrecision(12)), variable: false };
}

function normalizePricing(value: unknown): ModelPricing {
  const pricing = asRecord(value);
  const prompt = parsePrice(pricing?.prompt);
  const completion = parsePrice(pricing?.completion);
  // A variable price makes any fixed figure misleading: both stay unknown.
  if (prompt.variable || completion.variable) return { promptPerMTok: null, completionPerMTok: null, variable: true };
  return { promptPerMTok: prompt.perMTok, completionPerMTok: completion.perMTok, variable: false };
}

function asPositiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function nonEmpty(values: string[] | null): string[] | null {
  return values !== null && values.length > 0 ? values : null;
}

/** An empty `supported_parameters` list means the catalog does not say. */
function supportsAny(parameters: string[] | null, ...names: string[]): boolean | null {
  if (parameters === null || parameters.length === 0) return null;
  return names.some((name) => parameters.includes(name));
}

function isoDate(value: unknown): string | null {
  const text = asString(value);
  return text !== null && !Number.isNaN(Date.parse(text)) ? text : null;
}

/** Returns `null` for entries without a usable `author/model` id. */
export function normalizeOpenRouterModel(raw: unknown): ModelInfo | null {
  const entry = asRecord(raw);
  const id = asString(entry?.id);
  const author = id?.match(MODEL_ID)?.[1];
  if (!entry || !id || !author) return null;

  const architecture = asRecord(entry.architecture);
  const topProvider = asRecord(entry.top_provider);
  const parameters = asStringArray(entry.supported_parameters);
  const pricing = normalizePricing(entry.pricing);
  const created = asFiniteNumber(entry.created);

  return {
    id,
    name: asString(entry.name) ?? id,
    author,
    description: asString(entry.description),
    contextLength: asPositiveInt(entry.context_length) ?? asPositiveInt(topProvider?.context_length),
    maxCompletionTokens: asPositiveInt(topProvider?.max_completion_tokens),
    inputModalities: nonEmpty(asStringArray(architecture?.input_modalities)),
    outputModalities: nonEmpty(asStringArray(architecture?.output_modalities)),
    supportsTools: supportsAny(parameters, "tools"),
    supportsStructuredOutputs: supportsAny(parameters, "structured_outputs", "response_format"),
    supportsReasoning: supportsAny(parameters, "reasoning", "include_reasoning"),
    pricing,
    isFree:
      id.endsWith(":free") ||
      (!pricing.variable && pricing.promptPerMTok === 0 && pricing.completionPerMTok === 0),
    expirationDate: isoDate(entry.expiration_date),
    createdAt: created !== null && created > 0 ? Math.round(created * 1000) : null,
  };
}
