// L7 desktop presence: the tray shows Nomi's real state, closing the window keeps NOVA alive only
// when the user opted in (and never without a way back), and quitting asks only when something runs.
import type { MenuItemConstructorOptions } from "electron";
import type { DesktopActivity } from "@nova/shared";
import { describe, expect, it, vi } from "vitest";
import type { ActiveMission, DesktopSnapshot } from "../services/desktop-service";
import { createDesktopPresence, type ClosableWindow, type DesktopPresenceDeps, type TrayLike } from "./presence";
import { buildQuitWarning, QUIT_CANCEL } from "./quit-warning";
import { buildTrayView } from "./tray-menu";
import { decideWindowClose } from "./window-close";

const IDLE: DesktopActivity = {
  runningMissions: 0,
  waitingApprovals: 0,
  runningTerminals: 0,
  runningProcesses: 0,
  activeSchedules: 0,
  nextScheduledAt: null,
};

function snapshot(activity: Partial<DesktopActivity> = {}, missions: ActiveMission[] = [], unreadable: DesktopSnapshot["unreadable"] = []): DesktopSnapshot {
  return { state: { trayAvailable: true, keepRunningOnClose: false, activity: { ...IDLE, ...activity } }, missions, unreadable };
}

const running = (title: string, state: ActiveMission["state"] = "running"): ActiveMission => ({ id: title, title, state });

describe("tray view", () => {
  it("says Nomi rests when nothing runs, works during missions, and waits for an approval first", () => {
    const idle = buildTrayView(snapshot());
    expect(idle.status).toBe("idle");
    expect(idle.tooltip).toBe("NOVA · Nomi : au repos");
    expect(idle.title).toBe("");
    expect(idle.entries[3]).toEqual({ kind: "submenu", label: "Missions en cours", entries: [{ kind: "label", label: "Aucune mission en cours" }] });

    const working = buildTrayView(snapshot({ runningMissions: 2 }, [running("Corriger le panier"), running("Écrire les tests")]));
    expect(working.status).toBe("working");
    expect(working.entries[0]).toEqual({ kind: "label", label: "Nomi travaille : 2 missions en cours" });
    expect(working.title).toBe("2");

    const waiting = buildTrayView(snapshot({ runningMissions: 1, waitingApprovals: 1 }, [running("Déployer", "waiting_approval")]));
    expect(waiting.status).toBe("waiting");
    expect(waiting.entries[0]).toEqual({ kind: "label", label: "Nomi attend ta décision : 1 approbation" });
    expect(waiting.entries[3]).toMatchObject({ entries: [{ kind: "action", label: "Déployer (attend ton accord)" }] });
  });
});

describe("quit warning", () => {
  it("is asked only when something would stop", () => {
    expect(buildQuitWarning(snapshot())).toBeNull();
    const warning = buildQuitWarning(
      snapshot(
        { runningMissions: 4, waitingApprovals: 1, runningTerminals: 1, runningProcesses: 2, activeSchedules: 1, nextScheduledAt: Date.parse("2026-09-28T14:30:00") },
        [running("A"), running("B"), running("C"), running("D")],
      ),
      Date.parse("2026-09-28T10:00:00"),
    );
    expect(warning?.buttons[QUIT_CANCEL]).toBe("Annuler");
    expect(warning?.detail.split("\n")).toEqual([
      "Si tu quittes maintenant, ceci s'arrêtera :",
      "• 4 missions en cours : « A », « B », « C »…",
      "• 1 approbation en attente (la mission ne pourra pas continuer)",
      "• 1 terminal ouvert",
      "• 2 processus lancés par des missions",
      "• 1 planning actif : aucune exécution tant que NOVA est fermé (prochaine prévue à 14:30)",
    ]);
  });

  it("asks anyway when a source could not be read", () => {
    expect(buildQuitWarning(snapshot({}, [], ["missions"]))?.detail).toContain("NOVA n'a pas pu tout vérifier");
  });
});

describe("window close", () => {
  it("keeps NOVA running only when opted in, and never hides it without a tray", () => {
    expect(decideWindowClose({ keepRunningOnClose: false, trayAvailable: true, quitting: false })).toBe("close");
    expect(decideWindowClose({ keepRunningOnClose: true, trayAvailable: true, quitting: false })).toBe("hide");
    expect(decideWindowClose({ keepRunningOnClose: true, trayAvailable: false, quitting: false })).toBe("minimize");
    expect(decideWindowClose({ keepRunningOnClose: true, trayAvailable: true, quitting: true })).toBe("close");
  });
});

class FakeTray implements TrayLike {
  tooltip = "";
  title = "";
  menu: unknown = null;
  destroyed = false;
  readonly clicks: (() => void)[] = [];
  setToolTip(toolTip: string) {
    this.tooltip = toolTip;
  }
  setContextMenu(menu: unknown) {
    this.menu = menu;
  }
  setTitle(title: string) {
    this.title = title;
  }
  on(_event: "click", listener: () => void) {
    this.clicks.push(listener);
  }
  destroy() {
    this.destroyed = true;
  }
}

class FakeWindow implements ClosableWindow {
  hidden = false;
  minimized = false;
  private listener: ((event: { preventDefault(): void }) => void) | null = null;
  on(_event: "close", listener: (event: { preventDefault(): void }) => void) {
    this.listener = listener;
  }
  hide() {
    this.hidden = true;
  }
  minimize() {
    this.minimized = true;
  }
  /** Returns true when the close went through (not prevented). */
  close(): boolean {
    let prevented = false;
    this.listener?.({ preventDefault: () => (prevented = true) });
    return !prevented;
  }
}

function presenceSetup(options: { current?: DesktopSnapshot; keep?: boolean; trayFails?: boolean; answer?: boolean; platform?: NodeJS.Platform } = {}) {
  const tray = new FakeTray();
  let current = options.current ?? snapshot();
  const listeners: ((snapshot: DesktopSnapshot) => void)[] = [];
  const calls: string[] = [];
  const questions: string[] = [];
  const notices: string[] = [];
  let menus: MenuItemConstructorOptions[][] = [];
  const deps: DesktopPresenceDeps = {
    desktop: {
      snapshot: async () => current,
      onChange: (listener) => {
        listeners.push(listener);
        return () => undefined;
      },
      notify: () => calls.push("notify"),
    },
    createTray: () => {
      if (options.trayFails) throw new Error("no StatusNotifier host");
      return tray;
    },
    buildMenu: (template) => {
      menus = [...menus, template];
      return template;
    },
    keepRunningOnClose: () => options.keep ?? false,
    showWindow: () => calls.push("show"),
    quit: () => calls.push("quit"),
    askQuit: async (warning) => {
      questions.push(warning.detail);
      return options.answer ?? false;
    },
    notify: (body) => notices.push(body),
    platform: options.platform ?? "linux",
  };
  const presence = createDesktopPresence(deps);
  return {
    presence,
    tray,
    calls,
    questions,
    notices,
    menus: () => menus,
    emit: (next: DesktopSnapshot) => {
      current = next;
      for (const listener of listeners) listener(next);
    },
  };
}

describe("desktop presence", () => {
  it("renders the tray from real state changes and runs its menu actions", async () => {
    const setup = presenceSetup({ platform: "darwin" });
    await vi.waitFor(() => expect(setup.tray.tooltip).toBe("NOVA · Nomi : au repos"));
    expect(setup.calls).toContain("notify");
    setup.emit(snapshot({ runningMissions: 1 }, [running("Corriger le panier")]));
    expect(setup.tray.tooltip).toBe("NOVA · Nomi travaille : 1 mission en cours");
    expect(setup.tray.title).toBe("1");
    const menu = setup.menus().at(-1) ?? [];
    const submenu = menu[3]?.submenu as MenuItemConstructorOptions[];
    expect(submenu[0]?.label).toBe("Corriger le panier");
    submenu[0]?.click?.({} as never, undefined, {} as never);
    menu[5]?.click?.({} as never, undefined, {} as never);
    expect(setup.calls.filter((call) => call !== "notify")).toEqual(["show", "quit"]);
    setup.presence.dispose();
    expect(setup.tray.destroyed).toBe(true);
  });

  it("closing the window quits by default, hides behind the tray when opted in (said once)", () => {
    const off = presenceSetup();
    const window = new FakeWindow();
    off.presence.attachWindow(window);
    expect(window.close()).toBe(true);

    const on = presenceSetup({ keep: true });
    const kept = new FakeWindow();
    on.presence.attachWindow(kept);
    expect(kept.close()).toBe(false);
    expect(kept.hidden).toBe(true);
    kept.close();
    expect(on.notices).toEqual(["NOVA continue en arrière-plan. Retrouve Nomi dans la barre système pour rouvrir ou quitter."]);

    on.presence.setQuitting(true);
    expect(kept.close()).toBe(true);
    // A quit cancelled afterwards (unsaved edits kept): closing hides again.
    on.presence.setQuitting(false);
    expect(kept.close()).toBe(false);
  });

  it("without a tray, keeping NOVA alive minimizes the window instead of hiding it", () => {
    const setup = presenceSetup({ keep: true, trayFails: true });
    expect(setup.presence.trayAvailable()).toBe(false);
    const window = new FakeWindow();
    setup.presence.attachWindow(window);
    expect(window.close()).toBe(false);
    expect(window.minimized).toBe(true);
    expect(window.hidden).toBe(false);
  });

  it("asks before quitting only when activity > 0, and shares one question between repeated requests", async () => {
    const quiet = presenceSetup();
    expect(await quiet.presence.confirmQuit()).toBe(true);
    expect(quiet.questions).toEqual([]);

    const busy = presenceSetup({ current: snapshot({ runningMissions: 1 }, [running("Refactor")]), answer: false });
    const [first, second] = await Promise.all([busy.presence.confirmQuit(), busy.presence.confirmQuit()]);
    expect([first, second]).toEqual([false, false]);
    expect(busy.questions).toHaveLength(1);
    expect(busy.questions[0]).toContain("« Refactor »");
    expect(busy.calls).toContain("show");

    const confirmed = presenceSetup({ current: snapshot({ runningProcesses: 1 }), answer: true });
    expect(await confirmed.presence.confirmQuit()).toBe(true);
  });
});
