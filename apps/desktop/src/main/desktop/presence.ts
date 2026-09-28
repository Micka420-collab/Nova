// Desktop presence (J2-B L7): the tray / menu bar icon with Nomi's real state, the window close
// behavior (keep running only when the user opted in) and the question asked before quitting while
// something runs. Electron objects are injected (Tray, Menu, dialog, the window), so this module is
// tested in Node with fakes; index.ts passes the real ones.
import type { MenuItemConstructorOptions } from "electron";
import type { RuntimeLogger } from "@nova/agent-runtime";
import { describeError } from "../logger";
import type { DesktopService, DesktopSnapshot } from "../services/desktop-service";
import { desktopCopy } from "./copy";
import { buildQuitWarning, type QuitWarning } from "./quit-warning";
import { buildTrayView, type TrayAction, type TrayMenuEntry, type TrayView } from "./tray-menu";
import { decideWindowClose } from "./window-close";

/** The part of Electron's `Tray` used here. */
export interface TrayLike {
  setToolTip(toolTip: string): void;
  setContextMenu(menu: unknown): void;
  setTitle(title: string): void;
  on(event: "click", listener: () => void): unknown;
  destroy(): void;
}

/** The part of a `BrowserWindow` the close behavior needs. */
export interface ClosableWindow {
  on(event: "close", listener: (event: { preventDefault(): void }) => void): unknown;
  hide(): void;
  minimize(): void;
}

export interface DesktopPresenceDeps {
  desktop: Pick<DesktopService, "snapshot" | "onChange" | "notify">;
  /** `new Tray(image)`; throwing (no tray on this system) leaves NOVA without one. */
  createTray(): TrayLike;
  /** `Menu.buildFromTemplate`. */
  buildMenu(template: MenuItemConstructorOptions[]): unknown;
  /** `settings.desktop.keepRunningOnClose`, read at each close. */
  keepRunningOnClose(): boolean;
  /** Shows, restores and focuses the main window (creates it again when it was closed). */
  showWindow(): void;
  /** `app.quit()`: goes through `before-quit`, hence through `confirmQuit`. */
  quit(): void;
  /** Native question (`dialog.showMessageBox`); resolves true when the user chose to quit. */
  askQuit(warning: QuitWarning): Promise<boolean>;
  /** One system notification (the first time the window hides instead of closing). */
  notify?(body: string): void;
  platform: NodeJS.Platform;
  /** Longest wait for the activity check before quitting; default QUIT_CHECK_TIMEOUT_MS. */
  quitCheckTimeoutMs?: number;
  now?: () => number;
  logger?: RuntimeLogger;
}

export interface DesktopPresence {
  /** A tray icon exists (false when the system refused one). */
  trayAvailable(): boolean;
  /** Installs the close behavior on the main window (call for each window created). */
  attachWindow(window: ClosableWindow): void;
  /** Resolves true when quitting may go on (nothing runs, or the user confirmed). */
  confirmQuit(): Promise<boolean>;
  /**
   * A confirmed quit is under way (true): closing the window really closes it. False when the quit
   * was cancelled later (e.g. unsaved edits kept): closing follows the setting again.
   */
  setQuitting(quitting: boolean): void;
  /** Last view shown in the tray (tests, diagnostics). */
  view(): TrayView | null;
  dispose(): void;
}

/**
 * The activity check reads other services (the pty-host among them): a hung one must not make the
 * quit hang with it. Past this delay the check counts as failed, and quitting goes on.
 */
export const QUIT_CHECK_TIMEOUT_MS = 2_000;

function toTemplate(entries: TrayMenuEntry[], run: (action: TrayAction) => void): MenuItemConstructorOptions[] {
  return entries.map((entry): MenuItemConstructorOptions => {
    switch (entry.kind) {
      case "separator":
        return { type: "separator" };
      case "label":
        return { label: entry.label, enabled: false };
      case "action":
        return { label: entry.label, click: () => run(entry.action) };
      case "submenu":
        return { label: entry.label, submenu: toTemplate(entry.entries, run) };
    }
  });
}

export function createDesktopPresence(deps: DesktopPresenceDeps): DesktopPresence {
  let tray: TrayLike | null = null;
  let current: TrayView | null = null;
  let quitting = false;
  let noticeShown = false;
  let pendingQuestion: Promise<boolean> | null = null;

  const run = (action: TrayAction): void => {
    // A mission entry opens NOVA; the mission is listed in the window's mission list.
    if (action.kind === "quit") deps.quit();
    else deps.showWindow();
  };

  function render(snapshot: DesktopSnapshot): void {
    if (!tray) return;
    const view = buildTrayView(snapshot);
    current = view;
    try {
      tray.setToolTip(view.tooltip);
      if (deps.platform === "darwin") tray.setTitle(view.title);
      tray.setContextMenu(deps.buildMenu(toTemplate(view.entries, run)));
    } catch (error) {
      deps.logger?.warn("tray update failed", { error: describeError(error) });
    }
  }

  try {
    tray = deps.createTray();
    // Windows: a left click opens NOVA (the menu stays on right click); macOS and Linux show the menu.
    tray.on("click", () => {
      if (deps.platform === "win32") deps.showWindow();
    });
  } catch (error) {
    tray = null;
    deps.logger?.warn("tray unavailable", { error: describeError(error) });
  }
  const unsubscribe = deps.desktop.onChange(render);
  if (tray) {
    deps.desktop
      .snapshot()
      .then(render)
      .catch((error: unknown) => deps.logger?.warn("tray first state failed", { error: describeError(error) }));
  }
  // The renderer's `trayAvailable` changed from its default: publish it.
  deps.desktop.notify();

  return {
    trayAvailable: () => tray !== null,
    attachWindow(window) {
      window.on("close", (event) => {
        const decision = decideWindowClose({ keepRunningOnClose: deps.keepRunningOnClose(), trayAvailable: tray !== null, quitting });
        if (decision === "close") return;
        event.preventDefault();
        if (decision === "hide") window.hide();
        else window.minimize();
        // Closing did not quit: say so once, where the user looks (a system notification).
        if (!noticeShown) {
          noticeShown = true;
          deps.notify?.(decision === "hide" ? desktopCopy.backgroundNotice : desktopCopy.backgroundNoticeNoTray);
        }
      });
    },
    confirmQuit() {
      // Several quit requests while the question is open share its answer.
      pendingQuestion ??= (async () => {
        try {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const timedOut = new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("activity check timed out")), deps.quitCheckTimeoutMs ?? QUIT_CHECK_TIMEOUT_MS);
          });
          const snapshot = await Promise.race([deps.desktop.snapshot(), timedOut]).finally(() => clearTimeout(timer));
          const warning = buildQuitWarning(snapshot, (deps.now ?? Date.now)());
          if (!warning) return true;
          deps.showWindow();
          return await deps.askQuit(warning);
        } catch (error) {
          // Unable to check or to ask: quitting stays the user's explicit request.
          deps.logger?.error("quit check failed", { error: describeError(error) });
          return true;
        } finally {
          pendingQuestion = null;
        }
      })();
      return pendingQuestion;
    },
    setQuitting(value) {
      quitting = value;
    },
    view: () => current,
    dispose() {
      unsubscribe();
      tray?.destroy();
      tray = null;
    },
  };
}
