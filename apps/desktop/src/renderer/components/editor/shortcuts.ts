// Workbench shortcuts (POWER_UX §2.2 "Zones et focus" + "Éditeur"): a pure resolver, so the lead's
// global keymap can reuse it for Ctrl/Cmd+P and Ctrl/Cmd+Shift+F, and tests need no DOM.
// Letters are matched by `key` (what the keycap shows), digits by `code` (AZERTY needs Shift for them).

export type AtelierCommand =
  | { type: "save" }
  | { type: "saveAll" }
  | { type: "closeTab" }
  | { type: "reopenTab" }
  | { type: "cycleRecent"; direction: 1 | -1 }
  | { type: "cycleOrder"; direction: 1 | -1 }
  | { type: "goToTab"; index: number }
  | { type: "quickOpen" }
  | { type: "projectSearch" };

export type ShortcutEvent = Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey"> & {
  isComposing?: boolean;
};

export const IS_MAC = typeof navigator !== "undefined" && /Mac/i.test(navigator.userAgent);

export function resolveAtelierShortcut(event: ShortcutEvent, isMac: boolean = IS_MAC): AtelierCommand | null {
  if (event.isComposing) return null;
  const mod = isMac ? event.metaKey : event.ctrlKey;
  // AltGr arrives as Ctrl+Alt on Windows/Linux: never a NOVA shortcut (POWER_UX 2.1).
  if (!isMac && event.ctrlKey && event.altKey) return null;
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;

  // Ctrl+Tab is Control on every platform (⌃Tab on macOS).
  if (event.ctrlKey && !event.altKey && !event.metaKey && key === "Tab") {
    return { type: "cycleRecent", direction: event.shiftKey ? -1 : 1 };
  }

  const digit = /^Digit([1-9])$/.exec(event.code)?.[1];
  if (digit && !event.shiftKey && (isMac ? event.metaKey && !event.ctrlKey && !event.altKey : event.altKey && !event.ctrlKey)) {
    return { type: "goToTab", index: Number(digit) - 1 };
  }

  if (isMac && event.metaKey && event.altKey && !event.shiftKey && (key === "ArrowRight" || key === "ArrowLeft")) {
    return { type: "cycleOrder", direction: key === "ArrowRight" ? 1 : -1 };
  }
  if (!isMac && event.ctrlKey && !event.shiftKey && (key === "PageDown" || key === "PageUp")) {
    return { type: "cycleOrder", direction: key === "PageDown" ? 1 : -1 };
  }

  if (!mod || event.altKey) return null;
  switch (key) {
    case "s":
      return event.shiftKey ? { type: "saveAll" } : { type: "save" };
    case "w":
      return event.shiftKey ? null : { type: "closeTab" };
    case "t":
      return event.shiftKey ? { type: "reopenTab" } : null;
    case "p":
      return event.shiftKey ? null : { type: "quickOpen" };
    case "f":
      return event.shiftKey ? { type: "projectSearch" } : null;
    default:
      return null;
  }
}
