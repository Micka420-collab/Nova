import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TRAY_ICON_PNG_BASE64, trayIconSize } from "./tray-icon";

describe("tray icon", () => {
  it("is the rendered favicon of the design system (re-embed after `pnpm icons`)", () => {
    const file = join(import.meta.dirname, "../../../../../packages/ui/assets/favicon-32.png");
    expect(TRAY_ICON_PNG_BASE64).toBe(readFileSync(file).toString("base64"));
  });

  it("uses the size each platform's tray expects", () => {
    expect(trayIconSize("darwin")).toBe(16);
    expect(trayIconSize("win32")).toBe(16);
    expect(trayIconSize("linux")).toBe(22);
  });
});
