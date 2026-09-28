// L6 schedule repo: open runs (running / suspended) survive the history bound, since the scheduler
// finds a run's row from its mission and detects overlaps through them.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openNovaStore } from "../nova-store";
import type { NovaStore } from "../types";
import { createMissionRepo } from "./missions";
import { createScheduleRepo, type ScheduleRepo } from "./schedules";
import { createWorkspaceRepo } from "./workspaces";

let store: NovaStore;
let clock: number;
let schedules: ScheduleRepo;
let scheduleId: string;
let missionIds: [string, string];
const now = (): number => (clock += 1);

beforeEach(() => {
  clock = 1_000;
  store = openNovaStore(":memory:");
  const workspaceId = createWorkspaceRepo(store.db, now).upsertByRootPath({ rootPath: "/p", name: "p" }).id;
  schedules = createScheduleRepo(store.db, now);
  const missions = createMissionRepo(store.db, now);
  const mission = () =>
    missions.create({
      workspaceId,
      conversationId: null,
      title: "t",
      goal: "g",
      mode: "verify",
      modelId: "acme/m",
      contract: { profile: "read_only", isolationLevel: "L0", allowedOperations: ["read"], allowedHosts: [], maxDurationMs: 60_000, budgetUsd: 0.1 },
    }).id;
  missionIds = [mission(), mission()];
  scheduleId = schedules.create({
    workspaceId,
    title: "Tests du matin",
    goal: "Lancer les tests",
    mode: "verify",
    modelId: "acme/m",
    contract: { profile: "read_only", allowedOperations: ["read"], allowedHosts: [], webSearch: false, maxDurationMs: 60_000, budgetUsd: 0.1 },
    trigger: { kind: "interval", everyMinutes: 1 },
    missedPolicy: "skip",
    nextRunAt: 2_000,
  }).id;
});
afterEach(() => store.close());

describe("schedule repo (L6)", () => {
  it("never prunes an open run, however many newer runs were skipped", () => {
    const open = schedules.insertRun({ scheduleId, dueAt: 1, outcome: "running" });
    schedules.startRun(open.id, missionIds[0]);
    const suspended = schedules.insertRun({ scheduleId, dueAt: 2, outcome: "running" });
    schedules.startRun(suspended.id, missionIds[1]);
    schedules.finishRun(suspended.id, "suspended");
    for (let due = 3; due < 10; due += 1) schedules.insertRun({ scheduleId, dueAt: due, outcome: "skipped_overlap" });

    expect(schedules.pruneRuns(scheduleId, 3)).toBe(4);
    expect(schedules.listRuns(scheduleId, 20).map((run) => run.dueAt)).toEqual([9, 8, 7, 2, 1]);
    expect(schedules.runOfMission(missionIds[0])?.id).toBe(open.id);
    expect(schedules.listOpenRuns(scheduleId).map((run) => [run.id, run.outcome])).toEqual([
      [open.id, "running"],
      [suspended.id, "suspended"],
    ]);

    schedules.finishRun(open.id, "succeeded");
    schedules.finishRun(suspended.id, "cancelled");
    expect(schedules.listOpenRuns(scheduleId)).toEqual([]);
    expect(schedules.pruneRuns(scheduleId, 3)).toBe(2);
  });
});
