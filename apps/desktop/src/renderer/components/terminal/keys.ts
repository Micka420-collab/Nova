// Terminal keyboard contract (POWER_UX §2 and §5.5): the focused terminal owns every key except a
// short list of application shortcuts that must reach NOVA (`keysToSkipShell`), plus the terminal's
// own commands handled by the view (copy/paste, find, leave). Everything else goes to the shell,
// Ctrl+C without a selection (SIGINT), Ctrl+D, Ctrl+R, Ctrl+Z and Ctrl+W included.

/** Command ids for the lead's command registry. */
export const TERMINAL_COMMANDS = {
  /** Ctrl+J / ⌘J: show, focus or hide the dock terminal (`workspaceOpen`). */
  toggleDock: "dock.toggle",
  /** Ctrl+Shift+J / ⇧⌘J. */
  newSession: "terminal.new",
  /** Ctrl+Shift+W / ⇧⌘W… (see POWER_UX §2: ⌘W on macOS). */
  closeSession: "terminal.close",
  find: "terminal.find",
  explainFailure: "terminal.explainFailure",
  clear: "terminal.clear",
} as const;

export const TERMINAL_KEYBINDINGS = [
  { command: TERMINAL_COMMANDS.toggleDock, key: "Ctrl+J", mac: "⌘J", when: "workspaceOpen" },
  { command: TERMINAL_COMMANDS.newSession, key: "Ctrl+Shift+J", mac: "⇧⌘J", when: "workspaceOpen" },
  { command: TERMINAL_COMMANDS.closeSession, key: "Ctrl+Shift+W", mac: "⌘W", when: "terminalFocus" },
  { command: TERMINAL_COMMANDS.find, key: "Ctrl+F", mac: "⌘F", when: "terminalFocus" },
  { command: TERMINAL_COMMANDS.explainFailure, key: "Ctrl+Shift+X", mac: "⇧⌘X", when: "terminalFocus" },
] as const;

type KeyInput = Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "shiftKey" | "altKey" | "metaKey">;

export type TerminalKeyAction = "copy" | "paste" | "find" | "leave" | "explain" | "app" | "shell";

/** macOS uses ⌘ for the terminal's own commands; ⌃ keys stay the shell's there. */
function primary(event: KeyInput, mac: boolean): boolean {
  return mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

/** Application shortcuts that pass through the terminal (POWER_UX §5.5, `terminal.keysToSkipShell`). */
function isAppShortcut(event: KeyInput, mac: boolean): boolean {
  const { key, code, shiftKey, altKey } = event;
  if (key === "F1") return true;
  if (/^Digit[1-9]$/.test(code) && (primary(event, mac) || (altKey && !mac))) return true;
  if (!primary(event, mac)) return false;
  const lower = key.toLowerCase();
  if (key === "Tab" || key === "PageUp" || key === "PageDown") return true;
  if (shiftKey) return ["p", "b", "j", "r", "f", "w"].includes(lower);
  return ["b", "j", "i", "l", "p", ",", "k"].includes(lower);
}

/** What a keydown in the focused terminal does. `hasSelection`: xterm has selected text. */
export function terminalKeyAction(event: KeyInput, hasSelection: boolean, mac: boolean): TerminalKeyAction {
  if (event.key === "F6") return "leave";
  const mod = primary(event, mac);
  const lower = event.key.toLowerCase();
  if (mod && event.shiftKey && lower === "c") return "copy";
  if (mod && event.shiftKey && lower === "v") return "paste";
  if (mod && event.shiftKey && lower === "x") return "explain";
  if (mod && lower === "f") return "find";
  // Ctrl+C copies only when something is selected; otherwise it is SIGINT for the shell.
  if (mod && !event.shiftKey && lower === "c" && (hasSelection || mac)) return "copy";
  if (mac && mod && !event.shiftKey && lower === "v") return "paste";
  if (isAppShortcut(event, mac)) return "app";
  return "shell";
}

export const isMacPlatform = (): boolean => typeof navigator !== "undefined" && /Mac/i.test(navigator.userAgent);
