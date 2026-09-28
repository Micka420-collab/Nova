import { createMissionRepo, createSignalRepo, createSuggestionRepo, createWorkspaceRepo, type NovaStore, openNovaStore } from "@nova/storage";
import type { CompanionEvent, Mission, MissionEvent } from "@nova/shared";
import type { SystemNotification } from "@nova/companion";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCompanionService, type CompanionService } from "./companion-service";

let MISSION: string;
let WORKSPACE: string;

let store: NovaStore;
let clock: number;
let focused: boolean;
let events: CompanionEvent[];
let notifications: SystemNotification[];
let timers: { at: number; fn: () => void; cancelled: boolean }[];
let stops: string[];
let service: CompanionService;
let seq = 0;

function advance(ms: number): void {
  clock += ms;
  for (const timer of [...timers]) {
    if (!timer.cancelled && timer.at <= clock) {
      timer.cancelled = true;
      timer.fn();
    }
  }
}

function event<T extends MissionEvent["type"]>(type: T, payload: object): MissionEvent {
  seq += 1;
  clock += 1;
  return { id: `ev-${seq}`, seq, at: clock, missionId: MISSION, type, ...payload } as unknown as MissionEvent;
}

const approval = (id: string) => ({
  id,
  request: { workspaceId: WORKSPACE, missionId: MISSION, tool: "run_command", operation: "execute", argv: ["pnpm", "install"] },
  decision: { decision: "ask", reason: "profile_asks", ruleId: null, rememberable: true },
  toolCallId: null,
  status: "pending",
  scope: null,
  createdAt: 1,
  decidedAt: null,
});

function startMission(): void {
  service.onMissionEvent(
    event("mission.created", {
      mission: { id: MISSION, workspaceId: WORKSPACE, title: "Facturation", state: "ready" },
      contract: { workspaceId: WORKSPACE },
    }),
  );
  service.onMissionEvent(event("mission.started", { contract: { workspaceId: WORKSPACE } }));
}

function failTests(callId: string): void {
  service.onMissionEvent(event("tool.requested", { call: { id: callId, name: "run_tests" }, taskId: null }));
  service.onMissionEvent(event("tool.started", { callId, isolationLevel: null }));
  service.onMissionEvent(
    event("tool.finished", {
      callId,
      state: "failed",
      durationMs: 5,
      display: { kind: "tests", runner: "vitest", passed: 41, failed: 1, skipped: 0, exitCode: 1, proofId: null },
    }),
  );
}

beforeEach(() => {
  clock = 1_000_000;
  focused = true;
  events = [];
  notifications = [];
  timers = [];
  stops = [];
  store = openNovaStore(":memory:");
  const now = () => clock;
  // signals.workspace_id / mission_id reference real rows, as in production.
  WORKSPACE = createWorkspaceRepo(store.db, now).upsertByRootPath({ rootPath: "/tmp/w", name: "w" }).id;
  MISSION = createMissionRepo(store.db, now).create({
    workspaceId: WORKSPACE,
    conversationId: null,
    title: "Facturation",
    goal: "Corriger le total",
    mode: "fix",
    modelId: null,
    contract: {
      profile: "assisted",
      isolationLevel: "L0",
      allowedOperations: ["read"],
      allowedHosts: [],
      maxDurationMs: 900_000,
      budgetUsd: 4,
    },
  }).id;
  service = createCompanionService({
    signals: createSignalRepo(store.db, now),
    suggestions: createSuggestionRepo(store.db, now),
    missions: {
      stop: async ({ missionId }) => {
        stops.push(missionId);
        return { id: missionId, title: "Facturation", state: "cancelled" } as Mission;
      },
    },
    broadcast: (e) => events.push(e),
    notify: (n) => notifications.push(n),
    isFocused: () => focused,
    conversationTitle: () => "Article",
    now,
    minIntervalMs: 600_000,
    setTimer: (fn, ms) => {
      const timer = { at: clock + ms, fn, cancelled: false };
      timers.push(timer);
      return { cancel: () => (timer.cancelled = true) };
    },
  });
});

afterEach(() => {
  service.dispose();
  store.close();
});

describe("companion service", () => {
  it("records the signal before proposing a suggestion that references it", async () => {
    startMission();
    failTests("call-1");
    const types = events.map((e) => e.type);
    expect(types).toEqual(["signal", "suggestion"]);
    const signal = events[0]?.type === "signal" ? events[0].signal : null;
    const suggestion = events[1]?.type === "suggestion" ? events[1].suggestion : null;
    expect(signal).toMatchObject({ kind: "test_failed", workspaceId: WORKSPACE });
    expect(suggestion?.signalId).toBe(signal?.id);
    const state = await service.api.state({ workspaceId: null });
    expect(state.suggestion?.id).toBe(suggestion?.id);
    expect(state.signals.map((s) => s.id)).toEqual([signal?.id]);
  });

  it("the same fact is recorded once; a quiet runtime produces no signal", () => {
    startMission();
    expect(events).toEqual([]);
    failTests("call-1");
    const again = event("tool.finished", {
      callId: "call-1",
      state: "failed",
      durationMs: 5,
      display: { kind: "tests", runner: "vitest", passed: 41, failed: 1, skipped: 0, exitCode: 1, proofId: null },
    });
    service.onMissionEvent(again);
    expect(events.filter((e) => e.type === "signal")).toHaveLength(1);
  });

  it("rate-limits new suggestions, except approvals which block work", async () => {
    startMission();
    failTests("call-1");
    const firstId = (await service.api.state({ workspaceId: null })).suggestion?.id;
    await service.api.act({ suggestionId: firstId ?? "", response: "snooze" });
    failTests("call-2");
    expect((await service.api.state({ workspaceId: null })).suggestion).toBeNull();
    service.onMissionEvent(event("approval.requested", { approval: approval("33333333-3333-4333-8333-333333333333") }));
    const state = await service.api.state({ workspaceId: null });
    expect(state.suggestion?.action).toEqual({ type: "open_approval", approvalId: "33333333-3333-4333-8333-333333333333" });
  });

  it("the held suggestion is proposed when the interval ends", async () => {
    startMission();
    failTests("call-1");
    const first = (await service.api.state({ workspaceId: null })).suggestion;
    await service.api.act({ suggestionId: first?.id ?? "", response: "dismiss" });
    service.onMissionEvent(event("mission.suspended", { reason: "budget", detail: null }));
    expect((await service.api.state({ workspaceId: null })).suggestion).toBeNull();
    advance(600_000);
    expect((await service.api.state({ workspaceId: null })).suggestion?.action).toEqual({ type: "stop_mission", missionId: MISSION });
  });

  it("accepting a stop suggestion stops through the missions API; other actions navigate", async () => {
    startMission();
    service.onMissionEvent(event("mission.suspended", { reason: "budget", detail: null }));
    const suggestion = (await service.api.state({ workspaceId: null })).suggestion;
    const result = await service.api.act({ suggestionId: suggestion?.id ?? "", response: "accept" });
    expect(result).toMatchObject({ performedByMain: true, navigate: null, suggestion: { status: "accepted" } });
    expect(stops).toEqual([MISSION]);
    expect(events.at(-1)).toEqual({ type: "suggestion.cleared", suggestionId: suggestion?.id });
    await expect(service.api.act({ suggestionId: suggestion?.id ?? "", response: "accept" })).rejects.toMatchObject({ code: "conflict" });
  });

  it("mute_kind ignores the signal and stops recording that kind", async () => {
    startMission();
    failTests("call-1");
    const suggestion = (await service.api.state({ workspaceId: null })).suggestion;
    await service.api.act({ suggestionId: suggestion?.id ?? "", response: "mute_kind" });
    expect(service.mutedKinds().has("test_failed")).toBe(true);
    failTests("call-2");
    const state = await service.api.state({ workspaceId: null });
    expect(state.signals.map((s) => s.state)).toEqual(["ignored"]);
  });

  it("drops the visible suggestion when its fact is over (approval answered)", async () => {
    startMission();
    const id = "33333333-3333-4333-8333-333333333333";
    service.onMissionEvent(event("approval.requested", { approval: approval(id) }));
    expect((await service.api.state({ workspaceId: null })).suggestion).not.toBeNull();
    service.onMissionEvent(event("approval.resolved", { approval: { ...approval(id), status: "approved", scope: "once" } }));
    expect((await service.api.state({ workspaceId: null })).suggestion).toBeNull();
  });

  it("notifies the system only when unfocused, coalescing a mission's facts over 30 s", () => {
    startMission();
    service.onMissionEvent(event("approval.requested", { approval: approval("33333333-3333-4333-8333-333333333331") }));
    expect(notifications).toEqual([]);
    focused = false;
    service.onMissionEvent(event("approval.requested", { approval: approval("33333333-3333-4333-8333-333333333332") }));
    service.onMissionEvent(event("approval.requested", { approval: approval("33333333-3333-4333-8333-333333333333") }));
    expect(notifications.map((n) => n.body)).toEqual(["« Facturation » attend ta réponse : exécuter pnpm install."]);
    advance(30_000);
    expect(notifications.map((n) => n.body)).toEqual([
      "« Facturation » attend ta réponse : exécuter pnpm install.",
      "2 approbations en attente.",
    ]);
    expect(notifications[1]?.replacesGroup).toBe(true);
    expect(service.notices()).toHaveLength(3);
  });

  it("quiet mode holds mission ends but lets approvals through", () => {
    focused = false;
    startMission();
    service.setQuiet(clock + 3_600_000);
    service.onMissionEvent(event("mission.succeeded", { summary: "ok" }));
    expect(notifications).toEqual([]);
    expect(service.notices()[0]?.delivered).toBe("held");
  });

  it("reports a watched command from its real exit, once; unwatched exits are ignored", () => {
    focused = false;
    service.onProcessExit({ sessionId: "s1", exitCode: 1, signal: null, outputTail: "boom" });
    expect(notifications).toEqual([]);
    expect(service.watch("s1", WORKSPACE, ["pnpm", "test"])).toBe("started");
    expect(service.watch("s1", WORKSPACE, ["pnpm", "test"])).toBe("already");
    service.onProcessExit({ sessionId: "s1", exitCode: 1, signal: null, outputTail: " Tests  41 passed | 1 failed (42)" });
    expect(notifications.map((n) => n.body)).toEqual(["Tests terminés : 41 réussis, 1 échoué."]);
    expect(events.find((e) => e.type === "signal")).toMatchObject({ signal: { kind: "test_failed", sourceRef: { kind: "terminal", sessionId: "s1" } } });
    expect(service.isWatched("s1")).toBe(false);
  });

  it("a background chat failure notifies with the conversation title and reason only", () => {
    focused = false;
    service.onChatEvent({
      type: "failed",
      streamId: "st",
      conversationId: "c1",
      message: {} as never,
      error: { code: "insufficient_credits", httpStatus: 402, retryAfterSec: null, providerMessage: "secret stuff", retryable: false },
    });
    expect(notifications.map((n) => n.body)).toEqual(["« Article » a échoué : crédit épuisé."]);
  });
});
