// The scheduler of main (Pr5): one timer armed on the earliest due schedule, re-armed after every
// change. Decisions (which due time runs, which is recorded as missed/overlap/budget, the next due
// time) are taken synchronously before any await, so a timer firing twice never runs a due time
// twice. Every due time ends as a recorded run: started, or skipped with its reason.
import {
  SCHEDULE_LIMITS,
  isTerminalMissionState,
  type MissionState,
  type Schedule,
  type ScheduleEvent,
  type ScheduleRun,
  type ScheduleRunOutcome,
  type ScheduleState,
} from "@nova/shared";
import { nextRunAt } from "./next-run";

/** The subset of `ScheduleRepo` (@nova/storage) the scheduler uses. */
export interface ScheduleStoreLike {
  get(id: string): Schedule | null;
  listDue(at: number): Schedule[];
  setState(id: string, state: ScheduleState, nextRunAt: number | null): Schedule | null;
  markRan(id: string, ranAt: number, nextRunAt: number | null): Schedule | null;
  insertRun(input: { scheduleId: string; dueAt: number; outcome: ScheduleRunOutcome; missionId?: string | null; detail?: string | null }): ScheduleRun;
  startRun(runId: string, missionId: string): ScheduleRun | null;
  finishRun(runId: string, outcome: Exclude<ScheduleRunOutcome, "running">, detail?: string | null): ScheduleRun | null;
  runOfMission(missionId: string): ScheduleRun | null;
  listRunning(): ScheduleRun[];
  listOpenRuns(scheduleId: string): ScheduleRun[];
  pruneRuns(scheduleId: string, keep: number): number;
}

export type TimerHandle = unknown;

export interface SchedulerDeps {
  store: ScheduleStoreLike;
  /** Starts the mission of a run (plan + start with the schedule's contract); returns its id. */
  startMission(schedule: Schedule, runId: string): Promise<{ missionId: string }>;
  /** Current state of a mission; null when it does not exist. */
  missionState(missionId: string): MissionState | null;
  /** Whether today's remaining daily budget covers one run (the contract's budget). */
  canAfford(schedule: Schedule): boolean;
  push(event: ScheduleEvent): void;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
  /** A due time handled more than this late while NOVA runs (sleep, busy main) counts as missed. */
  lateGraceMs?: number;
  onError?(message: string, error: unknown): void;
}

export type ScheduleEndOutcome = Extract<ScheduleRunOutcome, "succeeded" | "failed" | "cancelled" | "suspended">;

export interface Scheduler {
  /** Settles runs left `running` by a previous session, applies missed-run policies, arms the timer. */
  start(): void;
  stop(): void;
  /** Re-arms after create/update/pause/resume/remove of a schedule. */
  reschedule(scheduleId: string): void;
  /** Handles every schedule due now; resolves once the runs it started are started (or failed to). */
  tick(): Promise<void>;
  /** A run's mission reached a terminal (or suspended) state; false when it is no scheduled run. */
  onMissionEnded(missionId: string, outcome: ScheduleEndOutcome): boolean;
  /** A suspended run's mission was resumed by the user. */
  onMissionResumed(missionId: string): boolean;
  /** Active schedules that will run while NOVA stays open (tray / quit warning). */
  activeCount(): number;
  nextDueAt(): number | null;
}

/** Longest single timer: a longer wait is re-checked (clock changes, sleep). */
const MAX_TIMER_MS = 60 * 60_000;
const DEFAULT_LATE_GRACE_MS = 2 * 60_000;
/** Due times enumerated per schedule and pass (older ones are summarized, never started). */
const MAX_DUE_PER_PASS = SCHEDULE_LIMITS.historyMax;
const EVERYTHING = Number.MAX_SAFE_INTEGER;

/** Short English code of a start failure (never content). */
function failureCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" && /^[a-z_]{1,40}$/.test(error.code)) {
    return `start_failed:${error.code}`;
  }
  return "start_failed:internal";
}

function endOutcomeOf(state: MissionState): ScheduleEndOutcome | null {
  if (state === "succeeded" || state === "failed" || state === "cancelled" || state === "suspended") return state;
  return null;
}

export function createScheduler(deps: SchedulerDeps): Scheduler {
  const { store } = deps;
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? ((callback, delay) => setTimeout(callback, delay));
  const clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const lateGraceMs = deps.lateGraceMs ?? DEFAULT_LATE_GRACE_MS;
  /** Schedules whose run is being started (between the decision and the mission id). */
  const starting = new Set<string>();
  let running = false;
  let timer: TimerHandle | null = null;

  const pushRun = (run: ScheduleRun | null): void => {
    if (run) deps.push({ type: "schedule.run", run });
  };
  const pushSchedule = (schedule: Schedule | null): void => {
    if (schedule) deps.push({ type: "schedule.updated", schedule });
  };
  const record = (scheduleId: string, dueAt: number, outcome: ScheduleRunOutcome, detail: string | null = null): ScheduleRun => {
    const run = store.insertRun({ scheduleId, dueAt, outcome, detail });
    pushRun(run);
    return run;
  };

  /** A previous run of the schedule still holds its mission (running, waiting for a human, suspended). */
  const isBusy = (scheduleId: string): boolean => {
    if (starting.has(scheduleId)) return true;
    return store.listOpenRuns(scheduleId).some((run) => {
      if (run.missionId === null) return false;
      const state = deps.missionState(run.missionId);
      return state !== null && !isTerminalMissionState(state);
    });
  };

  const settleFromMission = (run: ScheduleRun, missionId: string): void => {
    const state = deps.missionState(missionId);
    if (state === null) {
      pushRun(store.finishRun(run.id, "error", "mission_missing"));
      return;
    }
    const outcome = endOutcomeOf(state);
    if (outcome && run.outcome !== outcome) pushRun(store.finishRun(run.id, outcome));
  };

  /** Starts one run; `starting` is already held for the schedule. */
  async function execute(schedule: Schedule, run: ScheduleRun): Promise<void> {
    try {
      const { missionId } = await deps.startMission(schedule, run.id);
      const started = store.startRun(run.id, missionId);
      pushRun(started);
      // The mission may already have ended (or suspended) before its id came back.
      if (started) settleFromMission(started, missionId);
    } catch (error) {
      deps.onError?.("scheduled run failed to start", error);
      pushRun(store.finishRun(run.id, "error", failureCode(error)));
    } finally {
      starting.delete(schedule.id);
      store.pruneRuns(schedule.id, SCHEDULE_LIMITS.historyMax);
    }
  }

  /**
   * Decides what happens to every due time of one schedule (synchronously: markRan/setState move
   * `next_run_at` before any await); returns the start of the run it launched, if any.
   */
  function handleDue(schedule: Schedule, at: number, startup: boolean): Promise<void> | null {
    const dues: number[] = [];
    let cursor = schedule.nextRunAt;
    while (cursor !== null && cursor <= at && dues.length < MAX_DUE_PER_PASS) {
      dues.push(cursor);
      cursor = nextRunAt(schedule.trigger, cursor);
    }
    const truncated = cursor !== null && cursor <= at;
    // Too many missed to enumerate: re-anchor on now (the older ones are summarized below).
    const next = truncated ? nextRunAt(schedule.trigger, at) : cursor;
    const latest = dues.at(-1);
    if (latest === undefined) return null;

    const latestMissed = startup ? latest < at : at - latest > lateGraceMs;
    const runLatest = !latestMissed || schedule.missedPolicy === "run_once";
    const skipped = runLatest ? dues.slice(0, -1) : dues;
    skipped.forEach((dueAt, index) => {
      const detail = index === 0 && truncated ? "missed_truncated" : startup ? "nova_closed" : "late";
      record(schedule.id, dueAt, "skipped_missed", detail);
    });

    const state: ScheduleState = next === null ? "completed" : "active";
    if (runLatest && isBusy(schedule.id)) record(schedule.id, latest, "skipped_overlap", "previous_run_active");
    else if (runLatest && !deps.canAfford(schedule)) record(schedule.id, latest, "skipped_budget", "daily_budget");
    else if (runLatest) {
      starting.add(schedule.id);
      const run = record(schedule.id, latest, "running", latestMissed ? "catch_up" : null);
      store.markRan(schedule.id, at, next);
      pushSchedule(next === null ? store.setState(schedule.id, "completed", null) : store.get(schedule.id));
      return execute(schedule, run);
    }
    store.pruneRuns(schedule.id, SCHEDULE_LIMITS.historyMax);
    pushSchedule(store.setState(schedule.id, state, next));
    return null;
  }

  function processDue(startup: boolean): Promise<void>[] {
    const at = now();
    const started: Promise<void>[] = [];
    for (const schedule of store.listDue(at)) {
      try {
        const run = handleDue(schedule, at, startup);
        if (run) started.push(run);
      } catch (error) {
        deps.onError?.("schedule handling failed", error);
      }
    }
    return started;
  }

  function arm(): void {
    if (timer !== null) clearTimer(timer);
    timer = null;
    if (!running) return;
    const due = nextDueAt();
    if (due === null) return;
    const delay = Math.min(Math.max(0, due - now()), MAX_TIMER_MS);
    timer = setTimer(() => {
      timer = null;
      void tick();
    }, delay);
  }

  async function tick(): Promise<void> {
    if (!running) return;
    const started = processDue(false);
    arm();
    await Promise.all(started);
  }

  function recoverRunning(): void {
    for (const run of store.listRunning()) {
      if (run.missionId === null) {
        pushRun(store.finishRun(run.id, "error", "interrupted"));
        continue;
      }
      const state = deps.missionState(run.missionId);
      if (state === null) pushRun(store.finishRun(run.id, "error", "mission_missing"));
      else if (endOutcomeOf(state)) settleFromMission(run, run.missionId);
    }
  }

  function nextDueAt(): number | null {
    return store.listDue(EVERYTHING)[0]?.nextRunAt ?? null;
  }

  return {
    start() {
      if (running) return;
      running = true;
      recoverRunning();
      for (const run of processDue(true)) void run;
      arm();
    },
    stop() {
      running = false;
      arm();
    },
    reschedule() {
      arm();
    },
    tick,
    onMissionEnded(missionId, outcome) {
      const run = store.runOfMission(missionId);
      if (!run) return false;
      if (run.outcome !== outcome) pushRun(store.finishRun(run.id, outcome));
      // A run that frees its schedule may unblock nothing now, but the timer stays exact.
      arm();
      return true;
    },
    onMissionResumed(missionId) {
      const run = store.runOfMission(missionId);
      if (!run || run.outcome !== "suspended") return false;
      pushRun(store.startRun(run.id, missionId));
      return true;
    },
    activeCount: () => store.listDue(EVERYTHING).length,
    nextDueAt,
  };
}
