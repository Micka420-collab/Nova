import { describe, expect, it, vi } from "vitest";
import type { MissionState, Schedule, ScheduleEvent, ScheduleRun, ScheduleRunOutcome, ScheduleTrigger } from "@nova/shared";
import { createScheduler, type ScheduleStoreLike, type SchedulerDeps } from "./scheduler";

const MIN = 60_000;
const T0 = Date.parse("2026-06-10T08:00:00Z");

/** In-memory ScheduleStoreLike with the repo's semantics (listDue order, open runs kept by prune). */
function memoryStore(clock: () => number) {
  const schedules = new Map<string, Schedule>();
  const runs: ScheduleRun[] = [];
  let seq = 0;
  const patch = (id: string, fields: Partial<Schedule>): Schedule | null => {
    const current = schedules.get(id);
    if (!current) return null;
    const next = { ...current, ...fields, updatedAt: clock() };
    schedules.set(id, next);
    return next;
  };
  const patchRun = (id: string, fields: Partial<ScheduleRun>): ScheduleRun | null => {
    const index = runs.findIndex((run) => run.id === id);
    const current = runs[index];
    if (!current) return null;
    runs[index] = { ...current, ...fields };
    return runs[index] ?? null;
  };
  const store: ScheduleStoreLike = {
    get: (id) => schedules.get(id) ?? null,
    listDue: (time) =>
      [...schedules.values()]
        .filter((item) => item.state === "active" && item.nextRunAt !== null && item.nextRunAt <= time)
        .sort((a, b) => (a.nextRunAt ?? 0) - (b.nextRunAt ?? 0)),
    setState: (id, state, nextRunAt) => patch(id, { state, nextRunAt }),
    markRan: (id, ranAt, nextRunAt) => patch(id, { lastRunAt: ranAt, nextRunAt }),
    insertRun: (input) => {
      seq += 1;
      const running = input.outcome === "running";
      const run: ScheduleRun = {
        id: `run-${seq}`,
        scheduleId: input.scheduleId,
        missionId: input.missionId ?? null,
        dueAt: input.dueAt,
        startedAt: running ? clock() : null,
        endedAt: running ? null : clock(),
        outcome: input.outcome,
        detail: input.detail ?? null,
      };
      runs.push(run);
      return run;
    },
    startRun: (runId, missionId) => patchRun(runId, { missionId, outcome: "running", endedAt: null }),
    finishRun: (runId, outcome, detail = null) => patchRun(runId, { outcome, detail, endedAt: clock() }),
    runOfMission: (missionId) => runs.find((run) => run.missionId === missionId) ?? null,
    listRunning: () => runs.filter((run) => run.outcome === "running"),
    listOpenRuns: (scheduleId) => runs.filter((run) => run.scheduleId === scheduleId && (run.outcome === "running" || run.outcome === "suspended")),
    pruneRuns: () => 0,
  };
  const add = (fields: Partial<Schedule> & { trigger: ScheduleTrigger; nextRunAt: number | null }): Schedule => {
    const schedule: Schedule = {
      id: `s-${schedules.size + 1}`,
      workspaceId: "w",
      title: "Tests du matin",
      goal: "Lance les tests",
      mode: "verify",
      modelId: "vendor/model",
      contract: { profile: "assisted", allowedOperations: ["read"], allowedHosts: [], webSearch: false, maxDurationMs: 60_000, budgetUsd: 0.2 },
      missedPolicy: "skip",
      state: "active",
      lastRunAt: null,
      createdAt: 0,
      updatedAt: 0,
      ...fields,
    };
    schedules.set(schedule.id, schedule);
    return schedule;
  };
  return { store, add, runs, schedules };
}

function setup(options: { canAfford?: boolean; startFails?: unknown } = {}) {
  let time = T0;
  const clock = () => time;
  const memory = memoryStore(clock);
  const missions = new Map<string, MissionState>();
  const events: ScheduleEvent[] = [];
  const timers: { callback: () => void; delay: number }[] = [];
  let missionSeq = 0;
  const startMission = vi.fn<SchedulerDeps["startMission"]>(async () => {
    if (options.startFails !== undefined) throw options.startFails;
    missionSeq += 1;
    const missionId = `m-${missionSeq}`;
    missions.set(missionId, "running");
    return { missionId };
  });
  const scheduler = createScheduler({
    store: memory.store,
    startMission,
    missionState: (id) => missions.get(id) ?? null,
    canAfford: () => options.canAfford ?? true,
    push: (event) => events.push(event),
    now: clock,
    setTimer: (callback, delay) => {
      const timer = { callback, delay };
      timers.push(timer);
      return timer;
    },
    clearTimer: (handle) => {
      const index = timers.indexOf(handle as (typeof timers)[number]);
      if (index >= 0) timers.splice(index, 1);
    },
  });
  const outcomes = (scheduleId = "s-1"): [ScheduleRunOutcome, string | null][] =>
    memory.runs.filter((run) => run.scheduleId === scheduleId).map((run) => [run.outcome, run.detail]);
  return {
    ...memory,
    scheduler,
    startMission,
    missions,
    events,
    timers,
    outcomes,
    advance: (ms: number) => {
      time += ms;
    },
    settle: () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
  };
}

describe("scheduler: missed runs at startup", () => {
  const hourly: ScheduleTrigger = { kind: "interval", everyMinutes: 60 };

  it("skip: three due times missed while NOVA was closed are all recorded, none started", async () => {
    const t = setup();
    t.add({ trigger: hourly, nextRunAt: T0 - 150 * MIN, missedPolicy: "skip" });
    t.scheduler.start();
    await t.settle();
    expect(t.outcomes()).toEqual([
      ["skipped_missed", "nova_closed"],
      ["skipped_missed", "nova_closed"],
      ["skipped_missed", "nova_closed"],
    ]);
    expect(t.startMission).not.toHaveBeenCalled();
    // Anchored on the original due times: T0-150 → -90 → -30 → +30 minutes.
    expect(t.schedules.get("s-1")).toMatchObject({ state: "active", nextRunAt: T0 + 30 * MIN, lastRunAt: null });
    expect(t.timers.map((timer) => timer.delay)).toEqual([30 * MIN]);
  });

  it("run_once: one catch-up run for the latest, the older ones recorded as missed", async () => {
    const t = setup();
    t.add({ trigger: hourly, nextRunAt: T0 - 150 * MIN, missedPolicy: "run_once" });
    t.scheduler.start();
    await t.settle();
    expect(t.startMission).toHaveBeenCalledTimes(1);
    expect(t.outcomes()).toEqual([
      ["skipped_missed", "nova_closed"],
      ["skipped_missed", "nova_closed"],
      ["running", "catch_up"],
    ]);
    expect(t.runs.at(-1)).toMatchObject({ dueAt: T0 - 30 * MIN, missionId: "m-1" });
    expect(t.schedules.get("s-1")).toMatchObject({ nextRunAt: T0 + 30 * MIN, lastRunAt: T0 });
  });

  it("a once missed with skip completes the schedule; paused schedules are left alone", async () => {
    const t = setup();
    t.add({ trigger: { kind: "once", at: T0 - MIN }, nextRunAt: T0 - MIN });
    t.add({ trigger: hourly, nextRunAt: null, state: "paused" });
    t.scheduler.start();
    await t.settle();
    expect(t.outcomes("s-1")).toEqual([["skipped_missed", "nova_closed"]]);
    expect(t.schedules.get("s-1")).toMatchObject({ state: "completed", nextRunAt: null });
    expect(t.outcomes("s-2")).toEqual([]);
    expect(t.scheduler.activeCount()).toBe(0);
    expect(t.scheduler.nextDueAt()).toBeNull();
    expect(t.events).toContainEqual({ type: "schedule.updated", schedule: expect.objectContaining({ id: "s-1", state: "completed" }) });
  });

  it("settles runs a previous session left open from their mission's state", async () => {
    const t = setup();
    const schedule = t.add({ trigger: hourly, nextRunAt: T0 + 10 * MIN });
    const ended = t.store.insertRun({ scheduleId: schedule.id, dueAt: 1, outcome: "running", missionId: "old-1" });
    const orphan = t.store.insertRun({ scheduleId: schedule.id, dueAt: 2, outcome: "running" });
    const gone = t.store.insertRun({ scheduleId: schedule.id, dueAt: 3, outcome: "running", missionId: "old-3" });
    t.missions.set("old-1", "failed");
    t.scheduler.start();
    expect(t.store.runOfMission("old-1")).toMatchObject({ id: ended.id, outcome: "failed" });
    expect(t.runs.find((run) => run.id === orphan.id)).toMatchObject({ outcome: "error", detail: "interrupted" });
    expect(t.runs.find((run) => run.id === gone.id)).toMatchObject({ outcome: "error", detail: "mission_missing" });
  });
});

describe("scheduler: while NOVA runs", () => {
  it("never overlaps: a due time while the previous mission runs is skipped_overlap", async () => {
    const t = setup();
    t.add({ trigger: { kind: "interval", everyMinutes: 1 }, nextRunAt: T0 + MIN });
    t.scheduler.start();
    expect(t.timers.map((timer) => timer.delay)).toEqual([MIN]);
    t.advance(MIN);
    await t.scheduler.tick();
    expect(t.outcomes()).toEqual([["running", null]]);

    t.advance(MIN);
    // A mission waiting for an approval still holds the schedule.
    t.missions.set("m-1", "waiting_approval");
    await t.scheduler.tick();
    expect(t.outcomes()).toEqual([
      ["running", null],
      ["skipped_overlap", "previous_run_active"],
    ]);

    t.missions.set("m-1", "succeeded");
    expect(t.scheduler.onMissionEnded("m-1", "succeeded")).toBe(true);
    t.advance(MIN);
    await t.scheduler.tick();
    expect(t.outcomes()).toEqual([
      ["succeeded", null],
      ["skipped_overlap", "previous_run_active"],
      ["running", null],
    ]);
    expect(t.startMission).toHaveBeenCalledTimes(2);
    expect(t.scheduler.onMissionEnded("not-scheduled", "failed")).toBe(false);
  });

  it("a suspended run holds the schedule until its mission ends; resume reopens it", async () => {
    const t = setup();
    t.add({ trigger: { kind: "interval", everyMinutes: 5 }, nextRunAt: T0 });
    t.scheduler.start();
    await t.settle();
    t.missions.set("m-1", "suspended");
    t.scheduler.onMissionEnded("m-1", "suspended");
    t.advance(5 * MIN);
    await t.scheduler.tick();
    expect(t.outcomes()).toEqual([
      ["suspended", null],
      ["skipped_overlap", "previous_run_active"],
    ]);
    t.missions.set("m-1", "running");
    expect(t.scheduler.onMissionResumed("m-1")).toBe(true);
    expect(t.outcomes()[0]).toEqual(["running", null]);
  });

  it("respects the daily budget: skipped_budget, nothing started", async () => {
    const t = setup({ canAfford: false });
    t.add({ trigger: { kind: "interval", everyMinutes: 30 }, nextRunAt: T0 });
    t.scheduler.start();
    await t.settle();
    expect(t.outcomes()).toEqual([["skipped_budget", "daily_budget"]]);
    expect(t.startMission).not.toHaveBeenCalled();
    expect(t.schedules.get("s-1")).toMatchObject({ nextRunAt: T0 + 30 * MIN, lastRunAt: null });
  });

  it("a start failure is recorded with its code only", async () => {
    const t = setup({ startFails: Object.assign(new Error("secret sk-or-v1-abc leaked?"), { code: "no_key" }) });
    t.add({ trigger: { kind: "interval", everyMinutes: 30 }, nextRunAt: T0 });
    t.scheduler.start();
    await t.settle();
    expect(t.outcomes()).toEqual([["error", "start_failed:no_key"]]);
    expect(JSON.stringify(t.events)).not.toContain("sk-or");
  });

  it("a due time handled late (sleep) follows the missed-run policy", async () => {
    const t = setup();
    t.add({ trigger: { kind: "interval", everyMinutes: 60 }, nextRunAt: T0 + MIN, missedPolicy: "skip" });
    t.scheduler.start();
    t.advance(20 * MIN);
    await t.scheduler.tick();
    expect(t.outcomes()).toEqual([["skipped_missed", "late"]]);
    expect(t.schedules.get("s-1")?.nextRunAt).toBe(T0 + 61 * MIN);
  });

  it("settles a run whose mission ended before its id came back", async () => {
    const t = setup();
    t.startMission.mockImplementationOnce(async () => {
      t.missions.set("fast", "succeeded");
      return { missionId: "fast" };
    });
    t.add({ trigger: { kind: "once", at: T0 }, nextRunAt: T0 });
    t.scheduler.start();
    await t.settle();
    expect(t.outcomes()).toEqual([["succeeded", null]]);
    expect(t.schedules.get("s-1")).toMatchObject({ state: "completed", nextRunAt: null, lastRunAt: T0 });
  });

  it("stop() disarms the timer; a tick after stop does nothing", async () => {
    const t = setup();
    t.add({ trigger: { kind: "interval", everyMinutes: 1 }, nextRunAt: T0 + MIN });
    t.scheduler.start();
    expect(t.timers).toHaveLength(1);
    t.scheduler.stop();
    expect(t.timers).toHaveLength(0);
    t.advance(MIN);
    await t.scheduler.tick();
    expect(t.outcomes()).toEqual([]);
  });

  it("caps a long wait so clock changes are re-checked", () => {
    const t = setup();
    t.add({ trigger: { kind: "interval", everyMinutes: 60 * 24 }, nextRunAt: T0 + 24 * 60 * MIN });
    t.scheduler.start();
    expect(t.timers.map((timer) => timer.delay)).toEqual([60 * MIN]);
  });
});
