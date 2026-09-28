import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MissionContractInput, MissionEvent, MissionPlanResult, ScheduleEvent } from "@nova/shared";
import { createMissionRepo, createScheduleRepo, createWorkspaceRepo, openNovaStore, type MissionRepo, type NovaStore } from "@nova/storage";
import type { MainApi } from "../api";
import { ServiceError } from "../service-error";
import { createSchedulesService, type SchedulesServiceDeps } from "./schedules-service";

const MIN = 60_000;
const T0 = Date.parse("2026-06-10T08:00:00Z");
const CONTRACT: MissionContractInput = {
  profile: "assisted",
  allowedOperations: ["read", "execute"],
  allowedHosts: [],
  webSearch: false,
  maxDurationMs: 10 * MIN,
  budgetUsd: 0.2,
};

let store: NovaStore;
let missions: MissionRepo;
let workspaceId: string;

beforeEach(() => {
  store = openNovaStore(":memory:");
  workspaceId = createWorkspaceRepo(store.db).upsertByRootPath({ rootPath: "/shop", name: "shop" }).id;
  missions = createMissionRepo(store.db);
});
afterEach(() => store.close());

function setup(options: { remainingUsd?: number | null; startFails?: boolean; supportsTools?: boolean | null } = {}) {
  let time = T0;
  const timers: (() => void)[] = [];
  const plan = vi.fn<MainApi["missions"]["plan"]>(async (req) => {
    const created = missions.create({
      workspaceId: req.workspaceId,
      conversationId: null,
      title: req.goal,
      goal: req.goal,
      mode: req.mode,
      modelId: req.modelId,
      contract: { profile: "assisted", isolationLevel: "L0", allowedOperations: ["read"], allowedHosts: [], maxDurationMs: MIN, budgetUsd: 0.2 },
    });
    return { mission: { id: created.id } } as MissionPlanResult;
  });
  const start = vi.fn<MainApi["missions"]["start"]>(async ({ missionId }) => {
    if (options.startFails) throw new ServiceError("conflict", "mission is failed");
    missions.setState(missionId, "running");
    return missions.get(missionId) as unknown as Awaited<ReturnType<MainApi["missions"]["start"]>>;
  });
  const stop = vi.fn<MainApi["missions"]["stop"]>(async ({ missionId }) => {
    missions.setState(missionId, "cancelled");
    return missions.get(missionId) as unknown as Awaited<ReturnType<MainApi["missions"]["stop"]>>;
  });
  const deps: SchedulesServiceDeps = {
    repo: createScheduleRepo(store.db, () => time),
    missions: { plan, start, stop },
    missionState: (id) => missions.get(id)?.state ?? null,
    workspaceExists: (id) => id === workspaceId,
    supportsTools: () => options.supportsTools ?? true,
    dailyRemainingUsd: () => (options.remainingUsd === undefined ? 5 : options.remainingUsd),
    now: () => time,
    setTimer: (callback) => {
      timers.push(callback);
      return callback;
    },
    clearTimer: (handle) => {
      const index = timers.indexOf(handle as () => void);
      if (index >= 0) timers.splice(index, 1);
    },
  };
  const service = createSchedulesService(deps);
  const events: ScheduleEvent[] = [];
  service.onEvent((event) => events.push(event));
  const fire = async (): Promise<void> => {
    const pending = timers.splice(0);
    for (const callback of pending) callback();
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  const create = (fields: Partial<Parameters<MainApi["schedules"]["create"]>[0]> = {}) =>
    service.api.create({
      workspaceId,
      title: "Tests du matin",
      goal: "Lance les tests et résume",
      mode: "verify",
      modelId: "vendor/model",
      contract: CONTRACT,
      trigger: { kind: "interval", everyMinutes: 1 },
      missedPolicy: "skip",
      ...fields,
    });
  const ended = (missionId: string, type: "mission.succeeded" | "mission.failed"): MissionEvent =>
    type === "mission.succeeded"
      ? { id: "e", missionId, seq: 9, at: time, type, summary: "ok" }
      : { id: "e", missionId, seq: 9, at: time, type, reason: "acceptance_failed", detail: null };
  return { service, events, plan, start, stop, fire, create, ended, timers, advance: (ms: number) => (time += ms) };
}

describe("schedules service", () => {
  it("validates before saving: workspace, cron, a trigger that never runs, a model without tools", async () => {
    const t = setup({ supportsTools: false });
    await expect(t.create({ workspaceId: "8b8f7e0a-0000-4000-8000-000000000000" })).rejects.toMatchObject({ code: "not_found" });
    await expect(t.create({ trigger: { kind: "cron", expression: "61 * * * *", timeZone: "UTC" } })).rejects.toMatchObject({
      code: "invalid_request",
      message: expect.stringMatching(/invalid cron: minute: 61/),
    });
    await expect(t.create({ trigger: { kind: "once", at: T0 - MIN } })).rejects.toMatchObject({ code: "invalid_request", message: /never runs/ });
    await expect(t.create()).rejects.toMatchObject({ code: "invalid_request", message: /tool calling/ });
    expect(await t.service.api.list({ workspaceId })).toEqual([]);
    expect(t.events).toEqual([]);
  });

  it("starts each run as a normal mission with the schedule's contract and follows it to its end", async () => {
    const t = setup();
    const schedule = await t.create();
    expect(schedule).toMatchObject({ state: "active", nextRunAt: T0 + MIN });
    expect(t.events).toEqual([{ type: "schedule.updated", schedule }]);
    t.service.start();
    expect(t.service.activeCount()).toBe(1);
    expect(t.service.nextDueAt()).toBe(T0 + MIN);

    t.advance(MIN);
    await t.fire();
    expect(t.plan).toHaveBeenCalledWith({
      workspaceId,
      conversationId: null,
      goal: "Lance les tests et résume",
      mode: "verify",
      modelId: "vendor/model",
      contract: CONTRACT,
    });
    const missionId = t.plan.mock.results[0] ? (await t.plan.mock.results[0].value).mission.id : "";
    expect(t.start).toHaveBeenCalledWith({ missionId, tasks: null, contract: CONTRACT });
    const [run] = await t.service.api.runs({ scheduleId: schedule.id, limit: 10 });
    expect(run).toMatchObject({ missionId, outcome: "running", dueAt: T0 + MIN });

    // The next due time while the mission still runs: no second mission.
    t.advance(MIN);
    await t.fire();
    expect(t.plan).toHaveBeenCalledTimes(1);

    missions.setState(missionId, "succeeded");
    t.service.onMissionEvent(t.ended(missionId, "mission.succeeded"));
    const runs = await t.service.api.runs({ scheduleId: schedule.id, limit: 10 });
    expect(runs.map((item) => item.outcome)).toEqual(["skipped_overlap", "succeeded"]);
    expect(t.events.filter((event) => event.type === "schedule.run").at(-1)).toMatchObject({ run: { missionId, outcome: "succeeded" } });
  });

  it("a mission planned but refused at start is cancelled and the run shows the error code", async () => {
    const t = setup({ startFails: true });
    const schedule = await t.create();
    t.service.start();
    t.advance(MIN);
    await t.fire();
    expect(t.stop).toHaveBeenCalledTimes(1);
    const [run] = await t.service.api.runs({ scheduleId: schedule.id, limit: 1 });
    expect(run).toMatchObject({ outcome: "error", detail: "start_failed:conflict", missionId: null });
  });

  it("respects the daily cap: a run whose budget exceeds what is left is skipped_budget", async () => {
    const t = setup({ remainingUsd: 0.1 });
    const schedule = await t.create();
    t.service.start();
    t.advance(MIN);
    await t.fire();
    expect(t.plan).not.toHaveBeenCalled();
    expect((await t.service.api.runs({ scheduleId: schedule.id, limit: 1 }))[0]).toMatchObject({ outcome: "skipped_budget" });
  });

  it("pause stops the runs; resume recomputes the next due time from now", async () => {
    const t = setup();
    const schedule = await t.create({ trigger: { kind: "interval", everyMinutes: 10 } });
    t.service.start();
    const paused = await t.service.api.setPaused({ scheduleId: schedule.id, paused: true });
    expect(paused).toMatchObject({ state: "paused", nextRunAt: null });
    expect(t.service.nextDueAt()).toBeNull();
    t.advance(30 * MIN);
    await t.fire();
    expect(t.plan).not.toHaveBeenCalled();
    expect(await t.service.api.runs({ scheduleId: schedule.id, limit: 10 })).toEqual([]);

    const resumed = await t.service.api.setPaused({ scheduleId: schedule.id, paused: false });
    expect(resumed).toMatchObject({ state: "active", nextRunAt: T0 + 40 * MIN });
    expect(t.service.nextDueAt()).toBe(T0 + 40 * MIN);
  });

  it("a new trigger re-arms from now and revives a completed schedule; editing the title keeps the due time", async () => {
    const t = setup();
    const schedule = await t.create({ trigger: { kind: "once", at: T0 + MIN } });
    t.service.start();
    t.advance(MIN);
    await t.fire();
    expect((await t.service.api.list({ workspaceId }))[0]).toMatchObject({ state: "completed", nextRunAt: null, lastRunAt: T0 + MIN });
    await expect(t.service.api.setPaused({ scheduleId: schedule.id, paused: true })).rejects.toMatchObject({ code: "conflict" });

    const revived = await t.service.api.update({ scheduleId: schedule.id, patch: { trigger: { kind: "daily", time: "12:00", timeZone: "Europe/Paris" } } });
    expect(revived).toMatchObject({ state: "active", nextRunAt: Date.parse("2026-06-10T10:00:00Z") });
    const renamed = await t.service.api.update({ scheduleId: schedule.id, patch: { title: "Tests de midi" } });
    expect(renamed).toMatchObject({ title: "Tests de midi", nextRunAt: revived.nextRunAt });
  });

  it("remove deletes the schedule and its history, pushes the removal, and unknown ids are not_found", async () => {
    const t = setup();
    const schedule = await t.create();
    await t.service.api.remove({ scheduleId: schedule.id });
    expect(t.events.at(-1)).toEqual({ type: "schedule.removed", scheduleId: schedule.id });
    await expect(t.service.api.runs({ scheduleId: schedule.id, limit: 1 })).rejects.toMatchObject({ code: "not_found" });
    await expect(t.service.api.remove({ scheduleId: schedule.id })).rejects.toMatchObject({ code: "not_found" });
    expect(t.service.activeCount()).toBe(0);
  });

  it("at startup, due times missed while NOVA was closed follow the policy and are all recorded", async () => {
    const t = setup();
    const schedule = await t.create({ trigger: { kind: "interval", everyMinutes: 60 }, missedPolicy: "run_once" });
    t.advance(3 * 60 * MIN + 30 * MIN);
    t.service.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const runs = await t.service.api.runs({ scheduleId: schedule.id, limit: 10 });
    expect(runs.map((run) => [run.outcome, run.detail])).toEqual([
      ["running", "catch_up"],
      ["skipped_missed", "nova_closed"],
      ["skipped_missed", "nova_closed"],
    ]);
    expect(t.plan).toHaveBeenCalledTimes(1);
  });
});
