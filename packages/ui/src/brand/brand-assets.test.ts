import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { NOMI_BODY, NOMI_HEAD, NOMI_TOP } from "../nomi/geometry";
import { palettes } from "../tokens";
import { MARK_PATH, WORDMARK_PATH } from "./paths";

const asset = (name: string) => readFileSync(new URL(`../../assets/${name}`, import.meta.url));
const svg = (name: string) => asset(name).toString("utf8");

/** Width and height from the IHDR chunk of a PNG file. */
function pngSize(bytes: Buffer): { width: number; height: number } {
  expect(bytes.subarray(1, 4).toString("ascii")).toBe("PNG");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

describe("brand assets stay in sync with the React components", () => {
  it.each(["logo-mark.svg", "logo-mark-mono.svg", "lockup.svg", "app-icon.svg"])("%s draws the shared mark", (name) => {
    const source = svg(name);
    expect(source).toContain(`d="${MARK_PATH}"`);
  });

  it.each(["wordmark.svg", "lockup.svg"])("%s draws the shared wordmark", (name) => {
    expect(svg(name)).toContain(`d="${WORDMARK_PATH}"`);
  });

  it("uses the brand colors: jade mark, mono in currentColor, icon tile on the dark background", () => {
    expect(svg("logo-mark.svg")).toContain(palettes.dark.accent);
    expect(svg("logo-mark-mono.svg")).not.toMatch(/#[0-9a-f]{6}/i);
    expect(svg("wordmark.svg")).not.toMatch(/#[0-9a-f]{6}/i);
    expect(svg("app-icon.svg")).toContain(`fill="${palettes.dark.bg}"`);
  });

  it("nomi.svg is drawn from the companion geometry", () => {
    const source = svg("nomi.svg");
    for (const path of [NOMI_BODY, NOMI_HEAD, NOMI_TOP]) expect(source).toContain(`d="${path}"`);
  });

  it("rendered icons exist at their declared sizes (run `pnpm icons` after editing app-icon.svg)", () => {
    const icon = (file: string) => readFileSync(new URL(`../../../../apps/desktop/build/${file}`, import.meta.url));
    expect(pngSize(icon("icon.png"))).toEqual({ width: 1024, height: 1024 });
    expect(pngSize(icon("icon-512.png"))).toEqual({ width: 512, height: 512 });
    expect(pngSize(icon("icon-256.png"))).toEqual({ width: 256, height: 256 });
    expect(pngSize(asset("favicon-32.png"))).toEqual({ width: 32, height: 32 });
  });
});
