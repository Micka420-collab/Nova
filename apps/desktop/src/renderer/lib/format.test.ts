import { describe, expect, it } from "vitest";
import { makeModel } from "../test/fake-bridge";
import { filterModels, DEFAULT_FILTERS } from "../components/models/filter";
import { formatContextLength, formatCost, formatModelPricing, formatPricePerMTok, formatRelative } from "./format";

// Intl separates groups and currency with (narrow) no-break spaces.
const plain = (text: string | null) => text?.replace(/[  ]/g, " ") ?? null;

describe("model prices", () => {
  it("shows variable and unknown prices as such, never as a number", () => {
    expect(formatPricePerMTok(null, false)).toBe("inconnu");
    expect(formatPricePerMTok(3, true)).toBe("variable");
    expect(formatPricePerMTok(null, true)).toBe("variable");
    expect(formatPricePerMTok(Number.NaN, false)).toBe("inconnu");
  });

  it("formats known prices per million tokens in dollars, and zero as free", () => {
    expect(plain(formatPricePerMTok(0.27, false))).toBe("0,27 $");
    expect(plain(formatPricePerMTok(0.075, false))).toBe("0,075 $");
    expect(plain(formatPricePerMTok(15, false))).toBe("15,00 $");
    expect(formatPricePerMTok(0, false)).toBe("gratuit");
  });

  it("formats each side of a pricing independently", () => {
    const price = formatModelPricing({ promptPerMTok: 0.27, completionPerMTok: null, variable: false });
    expect(plain(price.input)).toBe("0,27 $");
    expect(price.output).toBe("inconnu");
  });
});

describe("costs, sizes and times", () => {
  it("keeps unknown costs null and shows small costs with significant digits", () => {
    expect(formatCost(null)).toBeNull();
    expect(plain(formatCost(0.000123))).toBe("0,000123 $");
    expect(plain(formatCost(1.5))).toBe("1,50 $");
  });

  it("formats context lengths", () => {
    expect(formatContextLength(null)).toBeNull();
    expect(plain(formatContextLength(131_072))).toBe("131 k jetons");
    expect(plain(formatContextLength(1_000_000))).toBe("1 M jetons");
  });

  it("formats relative times in French", () => {
    const now = 10_000_000;
    expect(formatRelative(now - 10_000, now)).toBe("à l'instant");
    expect(formatRelative(now - 5 * 60_000, now)).toBe("il y a 5 minutes");
    expect(formatRelative(now - 24 * 3_600_000, now)).toBe("hier");
  });
});

describe("model filters", () => {
  const models = [
    makeModel({ id: "deepseek/deepseek-chat", supportsTools: true }),
    makeModel({ id: "acme/vision", inputModalities: ["image"], outputModalities: ["text"] }),
    makeModel({ id: "acme/mystery", inputModalities: null, outputModalities: null, isFree: true }),
  ];

  it("requires text in and out by default but keeps models whose modalities are unknown", () => {
    expect(filterModels(models, DEFAULT_FILTERS).map((model) => model.id)).toEqual([
      "deepseek/deepseek-chat",
      "acme/mystery",
    ]);
  });

  it("filters on tools (only when known), free models, author and text", () => {
    const ids = (filters: Partial<typeof DEFAULT_FILTERS>) =>
      filterModels(models, { ...DEFAULT_FILTERS, ...filters }).map((model) => model.id);
    expect(ids({ tools: true })).toEqual(["deepseek/deepseek-chat"]);
    expect(ids({ free: true })).toEqual(["acme/mystery"]);
    expect(ids({ author: "deepseek" })).toEqual(["deepseek/deepseek-chat"]);
    expect(ids({ text: false, query: "VISION" })).toEqual(["acme/vision"]);
  });
});
