// L8 timeline service: hits only on human text (not JSON keys nor ids), redacted excerpts cut
// after redaction, and forks that plan a NEW mission (nothing replayed, original untouched).
import { describe, expect, it } from "vitest";
import type { MissionContract, MissionEvent, MissionPlanRequest, MissionPlanResult } from "@nova/shared";
import { MissionError } from "../controller";
import type { MissionEventInput } from "../index";
import { TIMELINE_LIMITS, buildForkRecap, createTimelineService, eventText, excerptAt, matchOffset, type TimelineSearchRecordLike, type TimelineServiceDeps } from "./timeline";

const SECRET = "sk-or-v1-FAKE-TEST-KEY-not-a-real-secret-000";
const ORIGINAL = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CHILD = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function record(seq: number, type: TimelineSearchRecordLike["type"], payload: unknown): TimelineSearchRecordLike {
  return { missionId: ORIGINAL, missionTitle: "Panier", seq, type, at: seq * 10, payload: JSON.stringify(payload) };
}

const CONTRACT: MissionContract = {
  workspaceId: "11111111-1111-4111-8111-111111111111",
  mode: "fix",
  profile: "assisted",
  isolationLevel: "L0",
  allowedOperations: ["read", "write", "execute"],
  allowedHosts: ["example.org"],
  webSearch: false,
  maxDurationMs: 600_000,
  budgetUsd: 0.4,
  harness: { chain: false, autoContinue: { maxRounds: 2, budgetUsd: 0.1 }, subMissions: null },
};

function ev<T extends MissionEvent["type"]>(seq: number, type: T, payload: Omit<Extract<MissionEvent, { type: T }>, "id" | "seq" | "at" | "type" | "missionId">): MissionEvent {
  return { id: `e${seq}`, missionId: ORIGINAL, seq, at: seq, type, ...payload } as MissionEvent;
}

const EVENTS: MissionEvent[] = [
  ev(1, "mission.plan", {
    summary: "Corriger le total du panier.",
    tasks: [{ id: "t1", missionId: ORIGINAL, seq: 0, title: "Les tests passent", state: "todo", acceptance: { kind: "test_passes", detail: "npm test" } }],
  }),
  ev(2, "tool.requested", { call: { id: "c1", name: "run_tests", operation: "execute", argumentsPreview: "{}", path: null, host: null, argv: ["npm", "test"] }, taskId: null }),
  ev(3, "tool.finished", {
    callId: "c1",
    state: "failed",
    display: { kind: "tests", runner: "unknown", passed: 0, failed: 1, skipped: 0, exitCode: 1, proofId: null },
    durationMs: 5,
  }),
  ev(4, "task.updated", { task: { id: "t1", missionId: ORIGINAL, seq: 0, title: "Les tests passent", state: "failed", acceptance: { kind: "test_passes", detail: "npm test" } } }),
  ev(5, "message.completed", { messageId: "m1", content: `Le panier compte au lieu d'additionner. Clé vue : ${SECRET}`, usage: null }),
  ev(6, "tool.requested", { call: { id: "c2", name: "edit_file", operation: "write", argumentsPreview: "{}", path: "src/cart.js" as never, host: null, argv: null }, taskId: null }),
  ev(7, "tool.finished", {
    callId: "c2",
    state: "succeeded",
    display: { kind: "file_change", change: "modified", path: "src/cart.js" as never, fromPath: null, additions: 1, deletions: 1, checkpointId: null },
    durationMs: 5,
  }),
  ev(8, "mission.succeeded", { summary: "Total corrigé." }),
];

function setup(overrides: Partial<TimelineServiceDeps> = {}) {
  const plans: MissionPlanRequest[] = [];
  const links: unknown[] = [];
  const appended: MissionEventInput[] = [];
  const deps: TimelineServiceDeps = {
    search: { search: () => [] },
    missions: {
      get: (id) => (id === ORIGINAL ? { id, workspaceId: CONTRACT.workspaceId, title: "Panier", goal: "Corrige le panier", mode: "fix", modelId: "acme/m" } : null),
      events: (id) => (id === ORIGINAL ? EVENTS : []),
    },
    contractOf: (id) => (id === ORIGINAL ? CONTRACT : null),
    async plan(request) {
      plans.push(request);
      return {
        mission: {
          id: CHILD, workspaceId: request.workspaceId, conversationId: null, title: "Corrige le panier", goal: request.goal, mode: request.mode,
          state: "ready", modelId: request.modelId, createdAt: 1, startedAt: null, endedAt: null, updatedAt: 1,
        },
        contract: CONTRACT,
        tasks: [],
        summary: "",
        estimate: { minUsd: null, maxUsd: null, assumptions: "" },
      } satisfies MissionPlanResult;
    },
    links: { insert: (input) => links.push(input) },
    journal: { append: (event) => (appended.push(event), null) },
    ...overrides,
  };
  return { service: createTimelineService(deps), plans, links, appended };
}

describe("timeline search", () => {
  it("keeps hits whose human text matches, never a JSON key or an id", async () => {
    const rows = [
      record(9, "mission.failed", { reason: "acceptance_failed", detail: "Échec du test panier" }),
      // Only the key "detail" and an id match these queries: not a hit.
      record(8, "mission.failed", { reason: "internal", detail: "autre chose" }),
      record(7, "task.updated", { task: { id: "0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f", title: "x" } }),
    ];
    const { service } = setup({ search: { search: () => rows } });
    expect(await service.search({ query: "echec panier", workspaceId: null, missionId: null, limit: 10 })).toEqual([
      { missionId: ORIGINAL, missionTitle: "Panier", seq: 9, type: "mission.failed", at: 90, snippet: "acceptance_failed · Échec du test panier" },
    ]);
    expect(await service.search({ query: "detail", workspaceId: null, missionId: null, limit: 10 })).toEqual([]);
    expect(await service.search({ query: "0f0f0f0f", workspaceId: null, missionId: null, limit: 10 })).toEqual([]);
    expect(await service.search({ query: " ( ", workspaceId: null, missionId: null, limit: 10 })).toEqual([]);
  });

  it("asks the index for more rows than hits, and stops at the requested limit", async () => {
    const limits: number[] = [];
    const rows = Array.from({ length: 12 }, (_, index) => record(100 - index, "mission.succeeded", { summary: `panier ${index}` }));
    const { service } = setup({ search: { search: ({ limit }) => (limits.push(limit), rows) } });
    expect(await service.search({ query: "panier", workspaceId: null, missionId: null, limit: 5 })).toHaveLength(5);
    expect(limits).toEqual([5 * TIMELINE_LIMITS.overfetch]);
  });

  it("redacts before cutting: a secret near the cut never leaks, even partly", async () => {
    const long = `${"x ".repeat(200)}panier ${SECRET} ${"y ".repeat(200)}`;
    const { service } = setup({ search: { search: () => [record(3, "message.completed", { content: long })] } });
    const [hit] = await service.search({ query: "panier", workspaceId: null, missionId: null, limit: 1 });
    expect(hit?.snippet.length).toBeLessThanOrEqual(TIMELINE_LIMITS.snippetMaxChars);
    expect(hit?.snippet).toContain("panier");
    expect(hit?.snippet).not.toContain("0123456789abcdef");
    expect(hit?.snippet.startsWith("…")).toBe(true);
    expect(hit?.snippet.endsWith("…")).toBe(true);
  });

  it("finds accented text from an unaccented prefix and maps the excerpt back", () => {
    const text = "Mise à jour : la réduction s'applique au panier";
    expect(matchOffset(text, ["reduc"])).toBe(text.indexOf("réduction"));
    expect(matchOffset(text, ["panier", "reduc"])).toBe(text.indexOf("réduction"));
    expect(matchOffset(text, ["reduction", "pan"])).toBe(text.indexOf("réduction"));
    // Only the last term is a prefix.
    expect(matchOffset(text, ["reduc", "panier"])).toBeNull();
    expect(excerptAt("court", 0)).toBe("court");
  });

  it("reads string values of a payload, not ids nor hashes", () => {
    expect(eventText(JSON.stringify({ callId: "c1", display: { kind: "tests", proofId: "p" }, detail: "a  b\n c", hash: "f".repeat(64) }))).toBe("tests · p · a b c");
    expect(eventText("not json")).toBe("");
  });
});

describe("timeline fork", () => {
  it("plans a new mission with the original contract and a recap, links it, and journals mission.forked", async () => {
    const { service, plans, links, appended } = setup();
    const result = await service.fork({ missionId: ORIGINAL, atSeq: 5, goal: null, modelId: null });
    expect(result.mission.id).toBe(CHILD);
    const request = plans[0];
    expect(request).toMatchObject({
      workspaceId: CONTRACT.workspaceId,
      conversationId: null,
      mode: "fix",
      modelId: "acme/m",
      contract: {
        profile: "assisted",
        allowedOperations: ["read", "write", "execute"],
        allowedHosts: ["example.org"],
        webSearch: false,
        maxDurationMs: 600_000,
        budgetUsd: 0.4,
        harness: CONTRACT.harness,
      },
    });
    expect(request?.goal.startsWith("Corrige le panier\n\n---\nReprise de la mission « Panier » à partir de son événement n° 5.")).toBe(true);
    // Up to seq 5 only: the failed run is there, the later edit and success are not.
    expect(request?.goal).toContain("- run_tests npm test : échoué");
    expect(request?.goal).toContain("[en échec] Les tests passent");
    expect(request?.goal).not.toContain("edit_file");
    expect(request?.goal).not.toContain("Total corrigé");
    expect(request?.goal).not.toContain("0123456789abcdef");
    expect(links).toEqual([
      { childMissionId: CHILD, parentMissionId: ORIGINAL, kind: "fork", forkSeq: 5, depth: 1, reservedUsd: null, worktree: null, integration: null },
    ]);
    expect(appended).toEqual([{ type: "mission.forked", missionId: CHILD, fromMissionId: ORIGINAL, fromSeq: 5 }]);
  });

  it("uses the new goal and model when given", async () => {
    const { service, plans } = setup();
    await service.fork({ missionId: ORIGINAL, atSeq: 8, goal: "Ajoute une remise", modelId: "acme/other" });
    expect(plans[0]?.modelId).toBe("acme/other");
    expect(plans[0]?.goal.startsWith("Ajoute une remise\n\n---\n")).toBe(true);
    expect(plans[0]?.goal).toContain("État de la mission d'origine à ce moment : réussie : Total corrigé.");
  });

  it("refuses a seq outside the mission and an unknown mission, with no effect", async () => {
    const { service, plans, links, appended } = setup();
    await expect(service.fork({ missionId: ORIGINAL, atSeq: 99, goal: null, modelId: null })).rejects.toMatchObject({ code: "invalid_request" });
    await expect(service.fork({ missionId: CHILD, atSeq: 1, goal: null, modelId: null })).rejects.toBeInstanceOf(MissionError);
    await expect(service.fork({ missionId: CHILD, atSeq: 1, goal: null, modelId: null })).rejects.toMatchObject({ code: "not_found" });
    expect([plans, links, appended]).toEqual([[], [], []]);
  });

  it("asks for a model when the original has none", async () => {
    const { service } = setup({
      missions: {
        get: (id) => ({ id, workspaceId: CONTRACT.workspaceId, title: "Panier", goal: "g", mode: "fix", modelId: null }),
        events: () => EVENTS,
      },
    });
    await expect(service.fork({ missionId: ORIGINAL, atSeq: 1, goal: null, modelId: null })).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("drops the recap rather than exceed the goal limit", async () => {
    const { service, plans } = setup();
    const goal = "g".repeat(TIMELINE_LIMITS.goalMaxChars - 50);
    await service.fork({ missionId: ORIGINAL, atSeq: 5, goal, modelId: null });
    expect(plans[0]?.goal).toBe(goal);
  });
});

describe("buildForkRecap", () => {
  it("is bounded and lists only the last actions", () => {
    const many: MissionEvent[] = [];
    for (let index = 0; index < 60; index += 1) {
      many.push(ev(index * 2 + 1, "tool.requested", { call: { id: `c${index}`, name: "read_file", operation: "read", argumentsPreview: "{}", path: `f${index}.ts` as never, host: null, argv: null }, taskId: null }));
      many.push(ev(index * 2 + 2, "tool.finished", { callId: `c${index}`, state: "succeeded", display: { kind: "text", text: "" } as never, durationMs: 1 }));
    }
    const recap = buildForkRecap({ title: "T", atSeq: 1_000, events: many });
    expect(recap).toContain(`Dernières actions (${TIMELINE_LIMITS.recapActions} sur 60)`);
    expect(recap).toContain("read_file f59.ts");
    expect(recap).not.toContain("read_file f39.ts :");
    expect(buildForkRecap({ title: "T", atSeq: 1_000, events: many, maxChars: 100 }).length).toBeLessThanOrEqual(100);
  });
});
