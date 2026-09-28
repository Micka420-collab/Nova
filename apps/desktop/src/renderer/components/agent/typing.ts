// "Never steal focus while typing" (POWER_UX §4.6): an approval card takes focus on appearance only
// when the user is not typing in the composer, the editor or the terminal (keystroke < 2 s ago).
export const TYPING_GRACE_MS = 2_000;

let lastTypingAt = 0;
let installed = false;

export function isEditableElement(element: Element | null): boolean {
  if (!element) return false;
  if (element instanceof HTMLTextAreaElement) return true;
  if (element instanceof HTMLInputElement) return !["button", "checkbox", "radio", "submit", "reset"].includes(element.type);
  if (element instanceof HTMLElement && element.isContentEditable) return true;
  // CodeMirror and xterm render into contenteditable / helper textareas; both are covered above,
  // except xterm's container which carries role="application" / class "xterm".
  return element.closest(".xterm, .cm-editor") !== null;
}

/** Records keystrokes in editable elements; idempotent, installed by the agent panel. */
export function installTypingTracker(target: Window = window): () => void {
  if (installed) return () => undefined;
  installed = true;
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.target instanceof Element && isEditableElement(event.target)) lastTypingAt = Date.now();
  };
  target.addEventListener("keydown", onKeyDown, true);
  return () => {
    installed = false;
    target.removeEventListener("keydown", onKeyDown, true);
  };
}

export function isTypingNow(now = Date.now()): boolean {
  const active = typeof document === "undefined" ? null : document.activeElement;
  return isEditableElement(active) && now - lastTypingAt < TYPING_GRACE_MS;
}

/** Test hook: forget the last keystroke. */
export function resetTypingTracker(): void {
  lastTypingAt = 0;
}
