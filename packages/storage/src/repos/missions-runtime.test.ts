import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openNovaStore } from "../nova-store";
import type { NovaStore } from "../types";
import { createMissionRepo, type MissionRepo } from "./missions";
import { createWorkspaceRepo } from "./workspaces";

let store: NovaStore;
let clock: number;
let missions: MissionRepo;
let missionId: string;
let workspaceId: string;
const now = (): number => (clock += 1);

beforeEach(() => {
  clock = 1_000;
  store = openNovaStore(":memory:");
  workspaceId = createWorkspaceRepo(store.db, now).upsertByRootPath({ rootPath: "/p", name: "p" }).id;
  missions = createMissionRepo(store.db, now);
  missionId = missions.create({
    workspaceId,
    conversationId: null,
    title: "t",
    goal: "g",
    mode: "fix",
    modelId: "acme/m",
    contract: { profile: "assisted", isolationLevel: "L0", allowedOperations: ["read"], allowedHosts: [], maxDurationMs: 60_000, budgetUsd: 0.5 },
  }).id;
});
afterEach(() => store.close());

describe("mission lifecycle rows", () => {
  it("sets states with first-wins timestamps, lists and finds interrupted missions", () => {
    expect(missions.setState(missionId, "running", { startedAt: 5 })).toMatchObject({ state: "running", startedAt: 5 });
    expect(missions.setState(missionId, "suspended", { startedAt: 9 })).toMatchObject({ state: "suspended", startedAt: 5 });
    expect(missions.listInterrupted().map((mission) => mission.id)).toEqual([missionId]);
    missions.setState(missionId, "cancelled", { endedAt: 20 });
    expect(missions.listInterrupted()).toEqual([]);
    expect(missions.list(workspaceId, 1)).toMatchObject({ items: [{ id: missionId, endedAt: 20 }], hasMore: false });
    expect(missions.list(null, 10).items).toHaveLength(1);
  });

  it("replaces the plan and tracks task states", () => {
    const tasks = missions.replaceTasks(missionId, [
      { title: "Lire", acceptance: { kind: "manual", detail: "" } },
      { title: "Tester", acceptance: { kind: "test_passes", detail: "cart" } },
    ]);
    expect(tasks.map((task) => [task.seq, task.title, task.state])).toEqual([[0, "Lire", "todo"], [1, "Tester", "todo"]]);
    const second = tasks[1];
    if (!second) throw new Error("missing task");
    expect(missions.setTaskState(second.id, "verified")?.state).toBe("verified");
    expect(missions.replaceTasks(missionId, [{ title: "Seul", acceptance: { kind: "file_exists", detail: "a.ts" } }])).toHaveLength(1);
  });

  it("records tool calls, proofs and review decisions", () => {
    missions.toolCalls.insert({ id: "22222222-2222-4222-8222-222222222222", missionId, tool: "run_tests", operation: "execute", arguments: { filter: [] } });
    missions.toolCalls.setDecision("22222222-2222-4222-8222-222222222222", "allow", "profile:assisted");
    missions.toolCalls.markRunning("22222222-2222-4222-8222-222222222222");
    missions.toolCalls.finish("22222222-2222-4222-8222-222222222222", "failed", { exitCode: 1, resultSummary: "1 failed" });
    // A finished call cannot be finished again.
    missions.toolCalls.finish("22222222-2222-4222-8222-222222222222", "succeeded", { exitCode: 0, resultSummary: null });
    expect(missions.toolCalls.listByMission(missionId)).toMatchObject([{ state: "failed", decision: "allow", exitCode: 1 }]);

    const proof = missions.proofs.insert({
      missionId, taskId: null, toolCallId: "22222222-2222-4222-8222-222222222222", kind: "test", command: ["pnpm", "vitest"], exitCode: 1, summary: "1 failed", outputRef: null,
    });
    expect(missions.proofs.listByMission(missionId)).toEqual([proof]);
    expect(proof.command).toEqual(["pnpm", "vitest"]);

    missions.reviews.record(missionId, [{ path: "a.ts", hunkIndex: null, decision: "kept" }, { path: "a.ts", hunkIndex: 0, decision: "reverted" }]);
    missions.reviews.record(missionId, [{ path: "a.ts", hunkIndex: null, decision: "reverted" }]);
    expect(missions.reviews.list(missionId).map((d) => [d.hunkIndex, d.decision])).toEqual([[null, "reverted"], [0, "reverted"]]);
  });
});

describe("mission budget", () => {
  it("reserves within the mission cap, settles, keeps estimates for unknown costs, and releases", () => {
    const cost = missions.cost;
    const base = { missionId, missionBudgetUsd: 0.5, dailyLimitUsd: 5, dayStart: 0 };
    const first = cost.reserve({ ...base, amountUsd: 0.3 });
    if (!first.ok) throw new Error("expected a reservation");
    expect(cost.reserve({ ...base, amountUsd: 0.3 })).toEqual({ ok: false, reason: "budget", availableUsd: expect.closeTo(0.2, 9) });
    cost.settle(first.reservation.id, 0.1);
    cost.recordUsage({
      missionId, toolCallId: null, kind: "generation", providerId: "openrouter", modelId: "acme/m",
      servedModel: "acme/m", servedProvider: null, promptTokens: 100, completionTokens: 10, reasoningTokens: null, cachedTokens: null, cost: 0.1,
    });
    const second = cost.reserve({ ...base, amountUsd: 0.3 });
    if (!second.ok) throw new Error("expected a reservation");
    // Unknown cost: the estimate stays committed so the cap still holds.
    cost.settle(second.reservation.id, null);
    cost.recordUsage({
      missionId, toolCallId: null, kind: "generation", providerId: "openrouter", modelId: "acme/m",
      servedModel: null, servedProvider: null, promptTokens: null, completionTokens: null, reasoningTokens: null, cachedTokens: null, cost: null,
    });
    expect(cost.reserve({ ...base, amountUsd: 0.2 }).ok).toBe(false);
    const third = cost.reserve({ ...base, amountUsd: 0.05 });
    if (!third.ok) throw new Error("expected a reservation");
    cost.releaseOpen(missionId);
    const summary = cost.summary(missionId, 0);
    expect(summary).toMatchObject({ reservedUsd: 0, spentUsd: 0.1, unknownCostCalls: 1, dailySpentUsd: 0.1 });
    expect(summary.committedUsd).toBeCloseTo(0.4, 9);
    expect(summary.byModel).toEqual([
      { modelId: "acme/m", kind: "generation", calls: 2, promptTokens: 100, completionTokens: 10, costUsd: 0.1, unknownCostCalls: 1 },
    ]);
  });

  it("refuses beyond the daily limit, counting open reservations", () => {
    const base = { missionId, missionBudgetUsd: null, dailyLimitUsd: 1, dayStart: 0 };
    expect(missions.cost.reserve({ ...base, amountUsd: 0.8 }).ok).toBe(true);
    expect(missions.cost.reserve({ ...base, amountUsd: 0.3 })).toMatchObject({ ok: false, reason: "daily_budget" });
  });
});
