// Scheduled missions (L6): schedules and their run history mirrored from main (`schedules.list`,
// `schedules.runs` and the `schedules.onEvent` push). A standalone zustand store, slice-ready: the
// integrator can merge it into the app store (state + actions, no dependency on AppState). The
// counters (`activeCount`, `nextDueAt`) are read by the tray / quit warning (L7).
import { createStore, type StoreApi } from "zustand/vanilla";
import type { Schedule, ScheduleEvent, ScheduleRun } from "@nova/shared";

export interface SchedulesSliceState {
  /** Oldest first (as main lists them). */
  schedules: Schedule[];
  /** `unavailable`: main answers so (group not wired): the UI shows no control for it. */
  status: "idle" | "loading" | "ready" | "unavailable" | "error";
  /** Loaded run histories, newest first, per schedule id. */
  runs: Record<string, ScheduleRun[]>;
}

export interface SchedulesSliceActions {
  setSchedules(schedules: Schedule[]): void;
  setStatus(status: SchedulesSliceState["status"]): void;
  upsert(schedule: Schedule): void;
  setRuns(scheduleId: string, runs: ScheduleRun[]): void;
  forgetRuns(scheduleId: string): void;
  applyEvent(event: ScheduleEvent): void;
}

export type SchedulesSlice = SchedulesSliceState & SchedulesSliceActions;
export type SchedulesStore = StoreApi<SchedulesSlice>;

export const initialSchedulesState: SchedulesSliceState = { schedules: [], status: "idle", runs: {} };

const byCreation = (a: Schedule, b: Schedule) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function upserted(schedules: Schedule[], schedule: Schedule): Schedule[] {
  const others = schedules.filter((item) => item.id !== schedule.id);
  return [...others, schedule].sort(byCreation);
}

/** A pushed run replaces its row (same id) or goes first; only loaded histories are kept in sync. */
function withRun(runs: Record<string, ScheduleRun[]>, run: ScheduleRun): Record<string, ScheduleRun[]> {
  const known = runs[run.scheduleId];
  if (!known) return runs;
  const next = known.some((item) => item.id === run.id) ? known.map((item) => (item.id === run.id ? run : item)) : [run, ...known];
  return { ...runs, [run.scheduleId]: next.sort((a, b) => b.dueAt - a.dueAt) };
}

export function createSchedulesStore(initial: Partial<SchedulesSliceState> = {}): SchedulesStore {
  return createStore<SchedulesSlice>()((set) => ({
    ...initialSchedulesState,
    ...initial,
    setSchedules: (schedules) => set({ schedules: [...schedules].sort(byCreation) }),
    setStatus: (status) => set({ status }),
    upsert: (schedule) => set((state) => ({ schedules: upserted(state.schedules, schedule) })),
    setRuns: (scheduleId, runs) => set((state) => ({ runs: { ...state.runs, [scheduleId]: runs } })),
    forgetRuns: (scheduleId) =>
      set((state) => {
        const { [scheduleId]: _dropped, ...rest } = state.runs;
        return { runs: rest };
      }),
    applyEvent: (event) =>
      set((state) => {
        switch (event.type) {
          case "schedule.updated":
            return { schedules: upserted(state.schedules, event.schedule) };
          case "schedule.removed": {
            const { [event.scheduleId]: _dropped, ...runs } = state.runs;
            return { schedules: state.schedules.filter((item) => item.id !== event.scheduleId), runs };
          }
          case "schedule.run":
            return { runs: withRun(state.runs, event.run) };
        }
      }),
  }));
}

/** Schedules that will still run while NOVA stays open. */
export function activeSchedules(schedules: readonly Schedule[]): Schedule[] {
  return schedules.filter((item) => item.state === "active" && item.nextRunAt !== null);
}

export function nextDueAt(schedules: readonly Schedule[]): number | null {
  let earliest: number | null = null;
  for (const item of activeSchedules(schedules)) if (earliest === null || (item.nextRunAt ?? Infinity) < earliest) earliest = item.nextRunAt;
  return earliest;
}
