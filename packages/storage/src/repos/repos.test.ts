import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openNovaStore } from "../nova-store";
import type { NovaStore } from "../types";
import { createApprovalRepo } from "./approvals";
import { createMissionRepo, type NewMission } from "./missions";
import { createSignalRepo } from "./signals";
import { createWorkspaceRepo } from "./workspaces";

let store: NovaStore;
let clock: number;
const now = (): number => (clock += 1);

beforeEach(() => {
  clock = 1000;
  store = openNovaStore(":memory:");
});
afterEach(() => {
  store.close();
});

function newMission(workspaceId: string): NewMission {
  return {
    workspaceId,
    conversationId: null,
    title: "Total du panier",
    goal: "Le total du panier est faux",
    mode: "fix",
    modelId: null,
    contract: {
      profile: "assisted",
      isolationLevel: "L0",
      allowedOperations: ["read", "write", "execute"],
      allowedHosts: ["registry.npmjs.org"],
      maxDurationMs: 900_000,
      budgetUsd: 0.3,
    },
  };
}

describe("workspace repo", () => {
  it("upserts by root path, keeping the id and bumping last opened", () => {
    const workspaces = createWorkspaceRepo(store.db, now);
    const first = workspaces.upsertByRootPath({ rootPath: "/home/u/a", name: "a" });
    const other = workspaces.upsertByRootPath({ rootPath: "/home/u/b", name: "b" });
    const again = workspaces.upsertByRootPath({ rootPath: "/home/u/a", name: "a2" });

    expect(first).toMatchObject({
      rootPath: "/home/u/a",
      permissionProfile: "assisted",
      instructionFilesConsent: null,
      createdAt: 1001,
    });
    expect(again).toEqual({ ...first, name: "a2", lastOpenedAt: 1003 });
    expect(workspaces.get(first.id)).toEqual(again);
    expect(workspaces.get("missing")).toBeNull();
    expect(workspaces.listRecent().map((workspace) => workspace.id)).toEqual([first.id, other.id]);
    expect(workspaces.listRecent(1)).toHaveLength(1);
    expect(() => workspaces.upsertByRootPath({ rootPath: "relative", name: "x" })).toThrow(/absolute/);
  });
});

describe("mission repo", () => {
  it("creates a mission with its contract and replays its events in order", () => {
    const workspace = createWorkspaceRepo(store.db, now).upsertByRootPath({ rootPath: "/p", name: "p" });
    const missions = createMissionRepo(store.db, now);
    const mission = missions.create(newMission(workspace.id));

    expect(mission).toMatchObject({ state: "ready", mode: "fix", startedAt: null, endedAt: null });
    expect(mission.contract).toEqual({
      profile: "assisted",
      isolationLevel: "L0",
      allowedOperations: ["read", "write", "execute"],
      allowedHosts: ["registry.npmjs.org"],
      maxDurationMs: 900_000,
      budgetUsd: 0.3,
      createdAt: mission.createdAt,
    });
    expect(missions.get(mission.id)).toEqual(mission);
    expect(missions.get("missing")).toBeNull();

    const other = missions.create(newMission(workspace.id));
    const created = missions.appendEvent(mission.id, "mission.created", { plan: 3 });
    missions.appendEvent(other.id, "mission.created", null);
    const started = missions.appendEvent(mission.id, "mission.started", {});
    expect(missions.listEvents(mission.id)).toEqual([created, started]);
    expect(missions.listEvents(mission.id, created.seq)).toEqual([started]);
    expect(created.payload).toEqual({ plan: 3 });
  });

  it("rolls back the mission when its contract is invalid", () => {
    const workspace = createWorkspaceRepo(store.db, now).upsertByRootPath({ rootPath: "/p", name: "p" });
    const missions = createMissionRepo(store.db, now);
    const input = newMission(workspace.id);
    expect(() => missions.create({ ...input, contract: { ...input.contract, budgetUsd: -1 } })).toThrow(
      /CHECK constraint failed/,
    );
    expect(store.db.prepare("SELECT count(*) AS n FROM missions").get()?.["n"]).toBe(0);
  });
});

describe("approval and signal repos", () => {
  it("lists only pending approvals of the workspace", () => {
    const workspaces = createWorkspaceRepo(store.db, now);
    const workspace = workspaces.upsertByRootPath({ rootPath: "/p", name: "p" });
    const elsewhere = workspaces.upsertByRootPath({ rootPath: "/q", name: "q" });
    const mission = createMissionRepo(store.db, now).create(newMission(workspace.id));
    const approvals = createApprovalRepo(store.db, now);
    const input = {
      workspaceId: workspace.id,
      missionId: mission.id,
      toolCallId: null,
      request: { tool: "git_commit", operation: "git_mutation" },
      ruleId: "profile:assisted",
      expiresAt: null,
    };
    const pending = approvals.insert(input);
    const decided = approvals.insert(input);
    approvals.insert({ ...input, workspaceId: elsewhere.id, missionId: null });
    store.db.prepare("UPDATE approvals SET status = 'approved', scope = 'once' WHERE id = ?").run(decided.id);

    expect(pending).toMatchObject({ status: "pending", scope: null, decidedAt: null, request: input.request });
    expect(approvals.listPending(workspace.id)).toEqual([pending]);
  });

  it("records signals as new", () => {
    const signals = createSignalRepo(store.db, now);
    const signal = signals.insert({
      workspaceId: null,
      missionId: null,
      kind: "test_failed",
      sourceRef: "run:1",
      evidence: { path: "src/cart.test.ts", excerpt: "expected 12 to be 10" },
    });
    expect(signal).toMatchObject({ state: "new", kind: "test_failed", evidence: { path: "src/cart.test.ts" } });
    expect(signals.listNew()).toEqual([signal]);
  });
});
