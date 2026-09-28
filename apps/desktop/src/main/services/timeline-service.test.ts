// `timeline.*` and the continuation hook in main, without Electron: real SQLite (FTS index,
// mission links, cost ledger) and a real mission journal. The controller is reduced to what the
// service uses (plan / contractOf / journal), with plan creating the mission like the real one.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMissionJournal, eventFromRecord, type MissionJournal } from "@nova/missions";
import type { MissionContract, MissionEvent, MissionPlanRequest } from "@nova/shared";
import { createMissionLinkRepo, createMissionRepo, createWorkspaceRepo, openNovaStore, type MissionRepo, type NovaStore } from "@nova/storage";
import { ServiceError } from "../service-error";
import { createTimelineService, type TimelineMainService } from "./timeline-service";

const SECRET = "sk-or-v1-FAKE-TEST-KEY-not-a-real-secret-000";

let store: NovaStore;
let missions: MissionRepo;
let journal: MissionJournal;
let service: TimelineMainService;
let workspaceId: string;
let plans: MissionPlanRequest[];
let clock: number;
const contracts = new Map<string, MissionContract>();

function contractFor(budgetUsd: number, autoContinue: { maxRounds: number; budgetUsd: number } | null): MissionContract {
  return {
    workspaceId,
    mode: "fix",
    profile: "assisted",
    isolationLevel: "L0",
    allowedOperations: ["read", "write", "execute"],
    allowedHosts: [],
    webSearch: false,
    maxDurationMs: 600_000,
    budgetUsd,
    harness: { chain: false, autoContinue, subMissions: null },
  };
}

function createMission(title: string, contract: MissionContract): string {
  const record = missions.create({
    workspaceId,
    conversationId: null,
    title,
    goal: `${title}\ndétails`,
    mode: "fix",
    modelId: "acme/m",
    contract: { profile: "assisted", isolationLevel: "L0", allowedOperations: contract.allowedOperations, allowedHosts: [], maxDurationMs: contract.maxDurationMs, budgetUsd: contract.budgetUsd },
  });
  contracts.set(record.id, contract);
  const { contract: _stored, ...mission } = record;
  journal.append({ type: "mission.created", missionId: record.id, mission, contract });
  return record.id;
}

function storedEvents(missionId: string): MissionEvent[] {
  return missions.listEvents(missionId).map(eventFromRecord);
}

beforeEach(() => {
  clock = 1_000;
  const now = (): number => (clock += 1);
  store = openNovaStore(":memory:");
  workspaceId = createWorkspaceRepo(store.db, now).upsertByRootPath({ rootPath: "/shop", name: "shop" }).id;
  missions = createMissionRepo(store.db, now);
  journal = createMissionJournal({ store: missions, push: () => undefined, now });
  plans = [];
  contracts.clear();
  service = createTimelineService({
    store,
    missions: () => ({
      journal,
      contractOf: (id) => contracts.get(id) ?? null,
      async plan(request) {
        plans.push(request);
        const contract = contractFor(request.contract?.budgetUsd ?? 0.5, request.contract?.harness?.autoContinue ?? null);
        const id = createMission(request.goal.split("\n")[0] ?? "Mission", contract);
        const tasks = missions.replaceTasks(id, [{ title: "Les tests passent", acceptance: { kind: "test_passes", detail: "npm test" } }]).map(({ updatedAt: _u, ...task }) => task);
        journal.append({ type: "mission.plan", missionId: id, summary: "Plan repris.", tasks });
        const record = missions.get(id);
        if (!record) throw new Error("missing");
        const { contract: _stored, ...mission } = record;
        return { mission, contract, tasks, summary: "Plan repris.", estimate: { minUsd: null, maxUsd: null, assumptions: "" } };
      },
    }),
  });
});
afterEach(() => store.close());

describe("timeline.search", () => {
  it("finds events accent-insensitively with a redacted, human excerpt, scoped to a mission", async () => {
    const cart = createMission("Panier", contractFor(0.5, null));
    const bill = createMission("Facture", contractFor(0.5, null));
    journal.append({ type: "mission.failed", missionId: cart, reason: "acceptance_failed", detail: `Échec du test panier (jeton ${SECRET})` });
    journal.append({ type: "mission.succeeded", missionId: bill, summary: "Facture du panier corrigée" });

    const hits = await service.api.search({ query: "echec panier", workspaceId, missionId: null, limit: 20 });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ missionId: cart, missionTitle: "Panier", type: "mission.failed" });
    expect(hits[0]?.snippet).toContain("Échec du test panier");
    expect(hits[0]?.snippet).not.toContain("0123456789abcdef");
    expect(hits[0]?.snippet).not.toContain("{");

    expect((await service.api.search({ query: "panier", workspaceId, missionId: bill, limit: 20 })).map((hit) => hit.missionId)).toEqual([bill]);
    // "detail" is only a payload key: never a hit.
    expect(await service.api.search({ query: "detail", workspaceId: null, missionId: null, limit: 20 })).toEqual([]);
  });

  it("refuses a request outside the contract", async () => {
    await expect(service.api.search({ query: "", workspaceId: null, missionId: null, limit: 5 })).rejects.toMatchObject({ code: "invalid_request" });
  });
});

describe("timeline.fork", () => {
  it("creates a ready mission linked to the original, journals mission.forked, and leaves the original intact", async () => {
    const original = createMission("Panier", contractFor(0.4, { maxRounds: 2, budgetUsd: 0.1 }));
    journal.append({ type: "mission.failed", missionId: original, reason: "acceptance_failed", detail: "tests rouges" });
    const before = storedEvents(original);
    const at = before[0]?.seq ?? 0;

    const result = await service.api.fork({ missionId: original, atSeq: at, goal: null, modelId: null });
    expect(result.mission.state).toBe("ready");
    expect(result.mission.id).not.toBe(original);
    expect(plans[0]?.contract).toMatchObject({ budgetUsd: 0.4, harness: { autoContinue: { maxRounds: 2, budgetUsd: 0.1 } } });
    expect(createMissionLinkRepo(store.db).get(result.mission.id)).toMatchObject({ parentMissionId: original, kind: "fork", forkSeq: at, depth: 1 });
    expect(storedEvents(result.mission.id).map((event) => event.type)).toEqual(["mission.created", "mission.plan", "mission.forked"]);
    expect(storedEvents(result.mission.id).at(-1)).toMatchObject({ fromMissionId: original, fromSeq: at });
    expect(storedEvents(original)).toEqual(before);
    expect(missions.get(original)?.state).toBe("failed");
  });

  it("refuses the seq of another mission, an unknown mission and an invalid seq, with no new mission", async () => {
    const a = createMission("A", contractFor(0.5, null));
    const b = createMission("B", contractFor(0.5, null));
    const seqOfB = storedEvents(b)[0]?.seq ?? 0;
    const refused = service.api.fork({ missionId: a, atSeq: seqOfB, goal: null, modelId: null });
    await expect(refused).rejects.toBeInstanceOf(ServiceError);
    await expect(service.api.fork({ missionId: a, atSeq: seqOfB, goal: null, modelId: null })).rejects.toMatchObject({ code: "invalid_request" });
    await expect(service.api.fork({ missionId: "99999999-9999-4999-8999-999999999999", atSeq: 1, goal: null, modelId: null })).rejects.toMatchObject({ code: "not_found" });
    await expect(service.api.fork({ missionId: a, atSeq: 0, goal: null, modelId: null })).rejects.toMatchObject({ code: "invalid_request" });
    expect(plans).toEqual([]);
    expect(missions.list(null, 10).items).toHaveLength(2);
  });
});

describe("continuation hook", () => {
  it("journals rounds in SQLite and stops at the spend cap read from the cost ledger", async () => {
    const id = createMission("Panier", contractFor(1, { maxRounds: 5, budgetUsd: 0.05 }));
    const [task] = missions.replaceTasks(id, [{ title: "Les tests passent", acceptance: { kind: "test_passes", detail: "npm test" } }]);
    const open = [{ taskId: task?.id ?? "", title: "Les tests passent", reason: "tests en échec" }];
    const usage = (cost: number | null) =>
      missions.cost.recordUsage({
        missionId: id, toolCallId: null, kind: "generation", providerId: "openrouter", modelId: "acme/m", servedModel: null, servedProvider: null,
        promptTokens: 10, completionTokens: 1, reasoningTokens: null, cachedTokens: null, cost,
      });
    usage(0.3); // spent before the rounds: not counted against the cap.

    expect(await service.continuation.nextRound({ missionId: id, round: 1, open })).toMatchObject({ prompt: expect.stringContaining("Continuation round 1 of 5") });
    // Round 1 worked (a successful call that changed a file) and cost 0.06 $ > 0.05 $ cap.
    journal.append({ type: "tool.finished", missionId: id, callId: "c1", state: "succeeded", display: { kind: "file_change", change: "modified", path: "src/cart.js" as never, fromPath: null, additions: 1, deletions: 1, checkpointId: null }, durationMs: 1 });
    usage(0.06);
    expect(await service.continuation.nextRound({ missionId: id, round: 2, open })).toBeNull();
    const flow = storedEvents(id).filter((event) => event.type.startsWith("continuation."));
    expect(flow).toMatchObject([
      { type: "continuation.round", round: 1, maxRounds: 5, unprovenTaskIds: [task?.id] },
      { type: "continuation.stopped", reason: "budget", rounds: 1 },
    ]);
    // Stopped once: later calls add nothing.
    expect(await service.continuation.nextRound({ missionId: id, round: 2, open })).toBeNull();
    expect(storedEvents(id).filter((event) => event.type.startsWith("continuation."))).toHaveLength(2);
  });

  it("journals « proven » before the success that follows rounds", () => {
    const id = createMission("Panier", contractFor(1, { maxRounds: 3, budgetUsd: 0.5 }));
    journal.append({ type: "mission.started", missionId: id, contract: contracts.get(id) as MissionContract });
    journal.append({ type: "continuation.round", missionId: id, round: 1, maxRounds: 3, unprovenTaskIds: [] });
    const success = { type: "mission.succeeded" as const, missionId: id, summary: "Vert." };
    service.beforeRuntimeEvent(success);
    journal.append(success);
    expect(storedEvents(id).slice(-2).map((event) => event.type)).toEqual(["continuation.stopped", "mission.succeeded"]);
    expect(storedEvents(id).at(-2)).toMatchObject({ reason: "proven", rounds: 1 });
  });
});
