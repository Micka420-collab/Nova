import { describe, expect, it } from "vitest";
import { CONTRAST_TEXT, CONTRAST_UI, contrastRatio, relativeLuminance } from "./contrast";
import { palettes, type Palette, type ThemeName } from "./tokens";

type Key = keyof Palette;
interface Pair {
  fg: Key;
  bg: Key;
  use: string;
}

const SURFACES: Key[] = ["bg", "panel", "raised"];
const on = (fg: Key, bgs: Key[], use: string): Pair[] => bgs.map((bg) => ({ fg, bg, use }));

// Every foreground/background combination rendered by styles/components.css and styles/nomi.css.
const TEXT_PAIRS: Pair[] = [
  ...on("text", [...SURFACES, "raisedHover", "field"], "body text, secondary button, inputs"),
  ...on("textSecondary", [...SURFACES, "raisedHover", "field"], "hints, ghost button, placeholder, neutral badge, kbd"),
  ...on("onAccent", ["accent", "accentHover"], "primary button"),
  ...on("onDanger", ["danger", "dangerHover"], "danger button"),
  ...on("danger", SURFACES, "field error message"),
  ...on("accent", [...SURFACES, "accentSoft"], "links, jade badge and pill"),
  { fg: "amber", bg: "amberSoft", use: "amber badge and pill" },
  { fg: "danger", bg: "dangerSoft", use: "danger badge and pill" },
  ...on("text", ["infoSoft", "accentSoft", "amberSoft", "dangerSoft"], "callout text"),
  { fg: "tooltipText", bg: "tooltipBg", use: "tooltip" },
  { fg: "text", bg: "selection", use: "selected text" },
  { fg: "nomiEye", bg: "nomiHead", use: "Nomi eyes" },
  { fg: "nomiEye", bg: "nomiHeadError", use: "Nomi eyes (error)" },
];

const UI_PAIRS: Pair[] = [
  ...on("borderStrong", [...SURFACES, "field"], "input, switch and secondary button boundaries"),
  { fg: "borderStrong", bg: "raised", use: "selected segment outline" },
  ...on("focus", [...SURFACES, "field"], "focus ring"),
  ...on("accent", SURFACES, "switch on, active orbit, brand mark"),
  { fg: "textSecondary", bg: "field", use: "switch thumb (off)" },
  { fg: "onAccent", bg: "accent", use: "switch thumb (on)" },
  ...on("danger", [...SURFACES, "field"], "invalid field border"),
  { fg: "info", bg: "infoSoft", use: "info callout icon" },
  { fg: "accent", bg: "accentSoft", use: "success callout icon" },
  { fg: "amber", bg: "amberSoft", use: "warning callout icon" },
  { fg: "danger", bg: "dangerSoft", use: "danger callout icon" },
  ...on("info", ["raised"], "toast marker"),
  ...on("amber", ["raised"], "toast marker"),
  ...on("danger", ["raised"], "toast marker"),
  ...on("nomiEdge", SURFACES, "Nomi silhouette"),
  ...on("amber", SURFACES, "Nomi satellite (waiting)"),
  ...on("danger", SURFACES, "Nomi satellite (error)"),
];

const THEMES: ThemeName[] = ["dark", "light"];

describe("contrast helpers", () => {
  it("matches the WCAG reference values", () => {
    expect(relativeLuminance("#000000")).toBe(0);
    expect(relativeLuminance("#FFFFFF")).toBe(1);
    expect(contrastRatio("#000000", "#FFFFFF")).toBeCloseTo(21, 5);
    expect(contrastRatio("#767676", "#FFFFFF")).toBeCloseTo(4.54, 2);
    expect(contrastRatio("#111619", "#F2F5F3")).toBe(contrastRatio("#F2F5F3", "#111619"));
  });

  it("rejects colors it cannot measure", () => {
    expect(() => relativeLuminance("rgb(0 0 0)")).toThrow(/Expected an opaque #RRGGBB color/);
    expect(() => relativeLuminance("#FFF")).toThrow(/Expected an opaque #RRGGBB color/);
  });
});

describe.each(THEMES)("%s theme contrast", (theme) => {
  const palette = palettes[theme];

  it.each(TEXT_PAIRS.map((pair) => [`${pair.fg} on ${pair.bg} (${pair.use})`, pair] as const))(
    "text %s >= 4.5",
    (_name, pair) => {
      expect(contrastRatio(palette[pair.fg], palette[pair.bg])).toBeGreaterThanOrEqual(CONTRAST_TEXT);
    },
  );

  it.each(UI_PAIRS.map((pair) => [`${pair.fg} on ${pair.bg} (${pair.use})`, pair] as const))(
    "UI %s >= 3",
    (_name, pair) => {
      expect(contrastRatio(palette[pair.fg], palette[pair.bg])).toBeGreaterThanOrEqual(CONTRAST_UI);
    },
  );
});
