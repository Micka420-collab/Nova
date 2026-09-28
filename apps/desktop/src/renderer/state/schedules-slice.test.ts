import { describe, expect, it } from "vitest";
import type { Schedule, ScheduleRun } from "@nova/shared";
import { activeSchedules, createSchedulesStore, nextDueAt } from "./schedules-slice";

const schedule = (id: string, over: Partial<Schedule> = {}): Schedule => ({
  id,
  workspaceId: "w",
  title: id,
  goal: "g",
  mode: "verify",
  modelId: "vendor/model",
  contract: { profile: "assisted", allowedOperations: ["read"], allowedHosts: [], webSearch: false, maxDurationMs: 60_000, budgetUsd: 0.1 },
  trigger: { kind: "interval", everyMinutes: 5 },
  missedPolicy: "skip",
  state: "active",
  nextRunAt: 100,
  lastRunAt: null,
  createdAt: 1,
  updatedAt: 1,
  ...over,
});
const run = (id: string, scheduleId: string, dueAt: number, outcome: ScheduleRun["outcome"] = "running"): ScheduleRun => ({
  id,
  scheduleId,
  missionId: null,
  dueAt,
  startedAt: null,
  endedAt: null,
  outcome,
  detail: null,
});

describe("schedules slice", () => {
  it("applies pushed events: upsert, runs of loaded histories only, removal with its history", () => {
    const store = createSchedulesStore();
    store.getState().setSchedules([schedule("b", { createdAt: 2 }), schedule("a")]);
    store.getState().applyEvent({ type: "schedule.updated", schedule: schedule("b", { createdAt: 2, state: "paused", nextRunAt: null }) });
    expect(store.getState().schedules.map((item) => [item.id, item.state])).toEqual([
      ["a", "active"],
      ["b", "paused"],
    ]);

    store.getState().applyEvent({ type: "schedule.run", run: run("r0", "a", 1) });
    expect(store.getState().runs).toEqual({});
    store.getState().setRuns("a", [run("r1", "a", 5)]);
    store.getState().applyEvent({ type: "schedule.run", run: run("r2", "a", 9, "skipped_overlap") });
    store.getState().applyEvent({ type: "schedule.run", run: run("r1", "a", 5, "succeeded") });
    expect(store.getState().runs["a"]?.map((item) => [item.id, item.outcome])).toEqual([
      ["r2", "skipped_overlap"],
      ["r1", "succeeded"],
    ]);

    store.getState().applyEvent({ type: "schedule.removed", scheduleId: "a" });
    expect(store.getState().schedules.map((item) => item.id)).toEqual(["b"]);
    expect(store.getState().runs["a"]).toBeUndefined();
  });

  it("counts only schedules that will still run (tray / quit warning)", () => {
    const list = [schedule("a", { nextRunAt: 300 }), schedule("b", { nextRunAt: 200 }), schedule("c", { state: "paused", nextRunAt: null }), schedule("d", { state: "completed", nextRunAt: null })];
    expect(activeSchedules(list).map((item) => item.id)).toEqual(["a", "b"]);
    expect(nextDueAt(list)).toBe(200);
    expect(nextDueAt([])).toBeNull();
  });
});
