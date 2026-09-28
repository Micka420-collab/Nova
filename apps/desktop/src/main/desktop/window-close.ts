// What closing the main window does. Keeping NOVA alive is opt-in (`keepRunningOnClose`): without
// it, closing behaves as before (the app quits on Windows/Linux, stays in the dock on macOS).
// With it, the window hides behind the tray icon; when no tray could be created it is minimized
// instead, so NOVA is never left running with no way back to it.
export type CloseDecision = "close" | "hide" | "minimize";

export interface CloseContext {
  keepRunningOnClose: boolean;
  trayAvailable: boolean;
  /** A quit is under way (confirmed): the window really closes. */
  quitting: boolean;
}

export function decideWindowClose(context: CloseContext): CloseDecision {
  if (context.quitting || !context.keepRunningOnClose) return "close";
  return context.trayAvailable ? "hide" : "minimize";
}
