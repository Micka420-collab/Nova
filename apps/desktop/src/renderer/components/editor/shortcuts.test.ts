import { describe, expect, it } from "vitest";
import { resolveAtelierShortcut, type ShortcutEvent } from "./shortcuts";

function key(init: Partial<ShortcutEvent> & { key: string }): ShortcutEvent {
  return { code: "", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...init };
}

describe("atelier shortcuts", () => {
  it("maps the Windows/Linux bindings of POWER_UX 2.2", () => {
    const pc = (init: Partial<ShortcutEvent> & { key: string }) => resolveAtelierShortcut(key(init), false);
    expect(pc({ key: "s", ctrlKey: true })).toEqual({ type: "save" });
    expect(pc({ key: "S", ctrlKey: true, shiftKey: true })).toEqual({ type: "saveAll" });
    expect(pc({ key: "w", ctrlKey: true })).toEqual({ type: "closeTab" });
    expect(pc({ key: "T", ctrlKey: true, shiftKey: true })).toEqual({ type: "reopenTab" });
    expect(pc({ key: "Tab", ctrlKey: true })).toEqual({ type: "cycleRecent", direction: 1 });
    expect(pc({ key: "Tab", ctrlKey: true, shiftKey: true })).toEqual({ type: "cycleRecent", direction: -1 });
    expect(pc({ key: "PageDown", ctrlKey: true })).toEqual({ type: "cycleOrder", direction: 1 });
    expect(pc({ key: "p", ctrlKey: true })).toEqual({ type: "quickOpen" });
    expect(pc({ key: "F", ctrlKey: true, shiftKey: true })).toEqual({ type: "projectSearch" });
  });

  it("matches tab digits by physical key, so AZERTY (no Shift) works", () => {
    expect(resolveAtelierShortcut(key({ key: "&", code: "Digit1", altKey: true }), false)).toEqual({ type: "goToTab", index: 0 });
    expect(resolveAtelierShortcut(key({ key: "&", code: "Digit1", metaKey: true }), true)).toEqual({ type: "goToTab", index: 0 });
  });

  it("uses Cmd on macOS and ignores Ctrl there, except for Ctrl+Tab", () => {
    expect(resolveAtelierShortcut(key({ key: "s", metaKey: true }), true)).toEqual({ type: "save" });
    expect(resolveAtelierShortcut(key({ key: "s", ctrlKey: true }), true)).toBeNull();
    expect(resolveAtelierShortcut(key({ key: "Tab", ctrlKey: true }), true)).toEqual({ type: "cycleRecent", direction: 1 });
    expect(resolveAtelierShortcut(key({ key: "ArrowRight", metaKey: true, altKey: true }), true)).toEqual({ type: "cycleOrder", direction: 1 });
  });

  it("never fires on AltGr (Ctrl+Alt) or during IME composition", () => {
    expect(resolveAtelierShortcut(key({ key: "s", ctrlKey: true, altKey: true }), false)).toBeNull();
    expect(resolveAtelierShortcut(key({ key: "s", ctrlKey: true, isComposing: true }), false)).toBeNull();
  });
});
