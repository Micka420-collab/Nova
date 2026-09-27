/** macOS shows ⌘ where other platforms show Ctrl; shortcuts accept both modifiers everywhere. */
export const MOD_KEY = typeof navigator !== "undefined" && /Mac/i.test(navigator.userAgent) ? "⌘" : "Ctrl";
