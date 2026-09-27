import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { cssVarName, palettes, radius, space, type Palette, type ThemeName } from "./tokens";

const css = readFileSync(new URL("./styles/tokens.css", import.meta.url), "utf8");

function declarations(selector: string): Map<string, string> {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`tokens.css has no block for ${selector}`);
  const block = css.slice(start, css.indexOf("}", start));
  return new Map([...block.matchAll(/(--nv-[a-z0-9-]+):\s*([^;]+);/g)].map((m) => [m[1] ?? "", (m[2] ?? "").trim()]));
}

const BLOCKS: Record<ThemeName, string> = { dark: ':root,\n[data-theme="dark"]', light: '[data-theme="light"]' };

describe("tokens.css mirrors tokens.ts", () => {
  it.each(Object.keys(BLOCKS) as ThemeName[])("declares every %s palette color with the same value", (theme) => {
    const vars = declarations(BLOCKS[theme]);
    const keys = Object.keys(palettes[theme]) as Array<keyof Palette>;
    const expected = Object.fromEntries(keys.map((key) => [cssVarName(key), palettes[theme][key]]));
    const actual = Object.fromEntries(keys.map((key) => [cssVarName(key), vars.get(cssVarName(key))]));
    expect(actual).toEqual(expected);
  });

  it("declares the spacing and radius scales", () => {
    const root = declarations(":root");
    for (const [step, px] of Object.entries(space)) expect(root.get(`--nv-space-${step}`)).toBe(`${px}px`);
    for (const [name, px] of Object.entries(radius)) expect(root.get(`--nv-radius-${name}`)).toBe(`${px}px`);
  });

  it("maps palette keys to kebab-case variables", () => {
    expect(cssVarName("textSecondary")).toBe("--nv-text-secondary");
    expect(cssVarName("nomiHeadOffline")).toBe("--nv-nomi-head-offline");
  });
});
