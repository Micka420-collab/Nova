// Display formatting. Unknown values (null) are always rendered as such, never replaced by a guess.
import type { ModelPricing } from "@nova/shared";
import { fr } from "../copy/fr";

const LOCALE = "fr-FR";

const priceFormat = new Intl.NumberFormat(LOCALE, {
  style: "currency",
  currency: "USD",
  currencyDisplay: "narrowSymbol",
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});
const smallCostFormat = new Intl.NumberFormat(LOCALE, {
  style: "currency",
  currency: "USD",
  currencyDisplay: "narrowSymbol",
  maximumSignificantDigits: 3,
});
const integerFormat = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 0 });
const relativeFormat = new Intl.RelativeTimeFormat("fr", { numeric: "auto" });
const dateFormat = new Intl.DateTimeFormat(LOCALE, { dateStyle: "long" });

/** One side of a per-million-token price: amount, "gratuit", "variable" or "inconnu". */
export function formatPricePerMTok(value: number | null, variable: boolean): string {
  if (variable) return fr.models.variable;
  if (value === null || !Number.isFinite(value) || value < 0) return fr.app.unknown;
  if (value === 0) return fr.models.free;
  return priceFormat.format(value);
}

export function formatModelPricing(pricing: ModelPricing): { input: string; output: string } {
  return {
    input: formatPricePerMTok(pricing.promptPerMTok, pricing.variable),
    output: formatPricePerMTok(pricing.completionPerMTok, pricing.variable),
  };
}

/** A reported cost in USD credits; `null` stays unknown. */
export function formatCost(cost: number | null): string | null {
  if (cost === null || !Number.isFinite(cost) || cost < 0) return null;
  if (cost === 0) return priceFormat.format(0);
  return cost < 0.01 ? smallCostFormat.format(cost) : priceFormat.format(cost);
}

export function formatInteger(value: number): string {
  return integerFormat.format(value);
}

export function formatTokens(value: number | null): string | null {
  return value === null || !Number.isFinite(value) ? null : fr.format.tokens(integerFormat.format(value));
}

export function formatContextLength(value: number | null): string | null {
  if (value === null || !Number.isFinite(value) || value <= 0) return null;
  if (value < 1000) return fr.format.tokens(integerFormat.format(value));
  if (value < 1_000_000) return fr.format.kiloTokens(integerFormat.format(Math.round(value / 1000)));
  return fr.format.megaTokens(new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 1 }).format(value / 1_000_000));
}

const UNITS: ReadonlyArray<[Intl.RelativeTimeFormatUnit, number]> = [
  ["year", 365 * 24 * 3600],
  ["month", 30 * 24 * 3600],
  ["week", 7 * 24 * 3600],
  ["day", 24 * 3600],
  ["hour", 3600],
  ["minute", 60],
];

/** "à l'instant", "il y a 5 minutes", "hier"... A timestamp in the future reads as just now. */
export function formatRelative(at: number, now: number): string {
  const seconds = Math.round((now - at) / 1000);
  if (seconds < 45) return fr.format.justNow;
  for (const [unit, size] of UNITS) {
    if (seconds >= size) return relativeFormat.format(-Math.floor(seconds / size), unit);
  }
  return relativeFormat.format(-1, "minute");
}

/** ISO date (YYYY-MM-DD or full) in long French form; the raw string when unparsable. */
export function formatDate(iso: string): string {
  const time = Date.parse(iso);
  return Number.isNaN(time) ? iso : dateFormat.format(time);
}

/** Same rule as the store's list preview: whitespace collapsed, 120 code points at most. */
export function toPreview(content: string): string | null {
  const collapsed = content.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) return null;
  const chars = Array.from(collapsed);
  return chars.length > 120 ? `${chars.slice(0, 120).join("").trimEnd()}…` : collapsed;
}
