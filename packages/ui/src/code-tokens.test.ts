import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CONTRAST_TEXT, CONTRAST_UI, contrastRatio } from "./contrast";
import { codeCssVarName, codePalettes, palettes, type CodePalette, type ThemeName } from "./tokens";

const css = readFileSync(new URL("./styles/code.css", import.meta.url), "utf8");

function declarations(selector: string): Map<string, string> {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`code.css has no block for ${selector}`);
  const block = css.slice(start, css.indexOf("}", start));
  return new Map([...block.matchAll(/(--nv-[a-z0-9-]+):\s*([^;]+);/g)].map((m) => [m[1] ?? "", (m[2] ?? "").trim()]));
}

const BLOCKS: Record<ThemeName, string> = { dark: ':root,\n[data-theme="dark"]', light: '[data-theme="light"]' };
const THEMES: ThemeName[] = ["dark", "light"];
const KEYS = Object.keys(codePalettes.dark) as Array<keyof CodePalette>;
const SYNTAX = KEYS.filter((key) => key.startsWith("syn"));

describe("code.css mirrors codePalettes", () => {
  it.each(THEMES)("declares every %s code color with the same value", (theme) => {
    const vars = declarations(BLOCKS[theme]);
    const expected = Object.fromEntries(KEYS.map((key) => [codeCssVarName(key), codePalettes[theme][key]]));
    const actual = Object.fromEntries(KEYS.map((key) => [codeCssVarName(key), vars.get(codeCssVarName(key))]));
    expect(actual).toEqual(expected);
  });

  it("styles every syntax role with its own class", () => {
    for (const key of SYNTAX) {
      const name = codeCssVarName(key).slice("--nv-".length);
      expect(css).toMatch(new RegExp(`\\.nv-${name}\\s*\\{[^}]*color:\\s*var\\(--nv-${name}\\)`));
    }
  });

  it("maps keys to kebab-case variables", () => {
    expect(codeCssVarName("synKeyword")).toBe("--nv-syn-keyword");
    expect(codeCssVarName("diffAddBg")).toBe("--nv-diff-add-bg");
    expect(codeCssVarName("editorBg")).toBe("--nv-editor-bg");
  });
});

describe.each(THEMES)("%s code contrast", (theme) => {
  const code = codePalettes[theme];
  const ui = palettes[theme];
  // Surfaces a syntax-colored line can sit on (VISUAL.md §2.3 and diff rows of §2.2).
  const surfaces: Record<string, string> = {
    editorBg: code.editorBg,
    lineHighlight: code.lineHighlight,
    diffAddBg: code.diffAddBg,
    diffDelBg: code.diffDelBg,
    diffModBg: code.diffModBg,
    bg: ui.bg,
    panel: ui.panel,
    raised: ui.raised,
    field: ui.field,
  };
  const syntaxPairs = SYNTAX.flatMap((fg) =>
    Object.entries(surfaces).map(([bg, color]) => [`${fg} on ${bg}`, code[fg], color] as const),
  );

  it.each(syntaxPairs)("syntax %s >= 4.5", (_name, fg, bg) => {
    expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(CONTRAST_TEXT);
  });

  const textPairs = [
    ["diffAddFg on diffAddBg", code.diffAddFg, code.diffAddBg],
    ["diffDelFg on diffDelBg", code.diffDelFg, code.diffDelBg],
    ["diffModFg on diffModBg", code.diffModFg, code.diffModBg],
    ["gutterFg on editorBg", code.gutterFg, code.editorBg],
    ...(
      ["diffAddBg", "diffDelBg", "diffModBg", "diffAddWord", "diffDelWord", "matchBg", "matchCurrentBg", "bracketBg"] as const
    ).map((bg) => [`text on ${bg}`, ui.text, code[bg]] as const),
    ["text on selection", ui.text, ui.selection],
    ["text on editorBg", ui.text, code.editorBg],
  ] as const;

  it.each(textPairs)("text %s >= 4.5", (_name, fg, bg) => {
    expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(CONTRAST_TEXT);
  });

  it("cursor (accent) on the editor >= 3", () => {
    expect(contrastRatio(ui.accent, code.editorBg)).toBeGreaterThanOrEqual(CONTRAST_UI);
  });
});
