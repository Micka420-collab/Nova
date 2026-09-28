// `desktop.*` IPC group (J2-B L7): what runs right now, for the tray menu, the quit warning and the
// settings. Every count is read from the owning service (missions, approvals, terminals, agent
// processes, schedules); nothing is estimated. Sources report through `notify()` (called on their
// real events) and the state is recomputed once per burst, then pushed only when it changed.
// A source that is not wired counts 0 (the feature does not exist yet); a source that fails is
// logged and listed in `unreadable`, so the quit warning still asks instead of quitting blindly.
// No Electron import: tested in Node.
import type { RuntimeLogger } from "@nova/agent-runtime";
import type { DesktopActivity, DesktopEvent, DesktopState, MissionState } from "@nova/shared";
import type { MainApi } from "../api";
import { describeError } from "../logger";

/** A mission that would stop with NOVA (listed by title in the tray and the quit warning). */
export interface ActiveMission {
  id: string;
  title: string;
  state: MissionState;
}

/** States of a mission that is doing (or about to do) work in this process. */
const ACTIVE_MISSION_STATES: ReadonlySet<MissionState> = new Set(["running", "waiting_approval"]);

export type DesktopSourceName = "missions" | "approvals" | "terminals" | "processes" | "schedules";

export interface DesktopActivitySources {
  /** Recent missions (any state; the active ones are kept here). */
  missions?(): Promise<readonly ActiveMission[]>;
  /** Pending approvals, every workspace. */
  pendingApprovals?(): Promise<number>;
  /** Running terminal sessions (user and agent). */
  runningTerminals?(): Promise<number>;
  /** Running background processes of missions. */
  runningProcesses?(): Promise<number>;
  /** Active (not paused) schedules and the next due time (`Scheduler.activeCount/nextDueAt`). */
  schedules?(): { activeCount: number; nextDueAt: number | null };
}

export interface DesktopSnapshot {
  state: DesktopState;
  /** Active missions, most recently updated first (titles for the tray and the quit warning). */
  missions: ActiveMission[];
  /** Sources that failed this time: their count is unknown (shown as 0 in the state). */
  unreadable: DesktopSourceName[];
}

export interface DesktopServiceDeps {
  sources: DesktopActivitySources;
  /** `settings.desktop.keepRunningOnClose`. */
  keepRunningOnClose(): boolean;
  /** Whether a tray icon exists (set by the desktop presence once it tried to create one). */
  trayAvailable(): boolean;
  /** Push to the renderer on IPC_CHANNELS.desktopEvent. */
  push(event: DesktopEvent): void;
  /** Coalescing delay of `notify()` bursts. */
  debounceMs?: number;
  logger?: RuntimeLogger;
}

export interface DesktopService {
  api: Omit<MainApi["desktop"], "onEvent">;
  /** Reads every source now (the quit warning and the tray menu use it). */
  snapshot(): Promise<DesktopSnapshot>;
  /** A source changed (mission, approval, terminal, process, schedule or settings event). */
  notify(): void;
  /** Called with each new snapshot whose state differs from the previous one. */
  onChange(listener: (snapshot: DesktopSnapshot) => void): () => void;
  dispose(): void;
}

export const DESKTOP_NOTIFY_DEBOUNCE_MS = 150;

const EMPTY_ACTIVITY: DesktopActivity = {
  runningMissions: 0,
  waitingApprovals: 0,
  runningTerminals: 0,
  runningProcesses: 0,
  activeSchedules: 0,
  nextScheduledAt: null,
};

/** Total of what would stop with NOVA (schedules included: they only run while NOVA runs). */
export function activityCount(activity: DesktopActivity): number {
  return (
    activity.runningMissions + activity.waitingApprovals + activity.runningTerminals + activity.runningProcesses + activity.activeSchedules
  );
}

function sameState(a: DesktopState | null, b: DesktopState): boolean {
  return a !== null && JSON.stringify(a) === JSON.stringify(b);
}

export function createDesktopService(deps: DesktopServiceDeps): DesktopService {
  const listeners = new Set<(snapshot: DesktopSnapshot) => void>();
  const debounceMs = deps.debounceMs ?? DESKTOP_NOTIFY_DEBOUNCE_MS;
  let last: DesktopState | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  async function read<T>(name: DesktopSourceName, source: (() => Promise<T>) | undefined, none: T, unreadable: DesktopSourceName[]): Promise<T> {
    if (!source) return none;
    try {
      return await source();
    } catch (error) {
      unreadable.push(name);
      deps.logger?.warn("desktop activity source failed", { source: name, error: describeError(error) });
      return none;
    }
  }

  async function snapshot(): Promise<DesktopSnapshot> {
    const { sources } = deps;
    const unreadable: DesktopSourceName[] = [];
    const schedulesSource = sources.schedules;
    const [missions, waitingApprovals, runningTerminals, runningProcesses, schedules] = await Promise.all([
      read("missions", sources.missions, [] as readonly ActiveMission[], unreadable),
      read("approvals", sources.pendingApprovals, 0, unreadable),
      read("terminals", sources.runningTerminals, 0, unreadable),
      read("processes", sources.runningProcesses, 0, unreadable),
      read("schedules", schedulesSource ? async () => schedulesSource() : undefined, { activeCount: 0, nextDueAt: null }, unreadable),
    ]);
    const active = missions.filter((mission) => ACTIVE_MISSION_STATES.has(mission.state));
    const activity: DesktopActivity = {
      ...EMPTY_ACTIVITY,
      runningMissions: active.length,
      waitingApprovals,
      runningTerminals,
      runningProcesses,
      activeSchedules: schedules.activeCount,
      nextScheduledAt: schedules.activeCount > 0 ? schedules.nextDueAt : null,
    };
    return {
      state: { trayAvailable: deps.trayAvailable(), keepRunningOnClose: deps.keepRunningOnClose(), activity },
      missions: active,
      unreadable,
    };
  }

  async function refresh(): Promise<void> {
    const next = await snapshot();
    if (disposed || sameState(last, next.state)) return;
    last = next.state;
    try {
      deps.push({ type: "desktop.state", state: next.state });
    } catch (error) {
      deps.logger?.warn("desktop state push failed", { error: describeError(error) });
    }
    for (const listener of listeners) {
      try {
        listener(next);
      } catch (error) {
        deps.logger?.error("desktop listener failed", { error: describeError(error) });
      }
    }
  }

  return {
    api: {
      async state() {
        const current = await snapshot();
        return current.state;
      },
    },
    snapshot,
    notify() {
      if (disposed || timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        refresh().catch((error: unknown) => deps.logger?.error("desktop refresh failed", { error: describeError(error) }));
      }, debounceMs);
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      listeners.clear();
    },
  };
}
