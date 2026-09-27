import { MISSION_ID, MissionLog, approval } from "@nova/companion/testing";
import {
  NovaIpcError,
  type CompanionActResult,
  type CompanionAction,
  type CompanionSuggestion,
  type Mission,
  type MissionDetail,
} from "@nova/shared";
import { describe, expect, it } from "vitest";
import { createCompanionStore, type CompanionClient } from "./companion-slice";

const mission = (state: Mission["state"]): Mission => ({
  id: MISSION_ID,
  workspaceId: "w",
  conversationId: null,
  title: "Facturation",
  goal: "g",
  mode: "fix",
  state,
  modelId: null,
  createdAt: 1,
  startedAt: 1,
  endedAt: null,
  updatedAt: 1,
});

const suggestion = (action: CompanionAction): CompanionSuggestion => ({
  id: "sug-1",
  signalId: "sig-1",
  text: "Une mission attend ta réponse : exécuter pnpm install.",
  action,
  status: "proposed",
  createdAt: 1,
});

function setup(actResult: Partial<CompanionActResult> | Error = {}) {
  const log = new MissionLog().created("Facturation").started();
  const calls: string[] = [];
  const navigated: CompanionAction[] = [];
  const client = {
    companion: {
      state: async () => ({ suggestion: null, signals: [] }),
      act: async (req: { response: string }) => {
        calls.push(`act:${req.response}`);
        if (actResult instanceof Error) throw actResult;
        return { suggestion: suggestion({ type: "open_approval", approvalId: "a1" }), performedByMain: false, navigate: null, ...actResult };
      },
      onEvent: () => () => {},
    },
    missions: {
      get: async () => ({ mission: mission("running"), events: log.events }) as unknown as MissionDetail,
      stop: async () => {
        calls.push("missions.stop");
        return mission("cancelled");
      },
      resume: async () => mission("running"),
      list: async () => ({ items: [mission("running")], hasMore: false }),
      onEvent: () => () => {},
    },
    approvals: { list: async () => [approval("a1")] },
  } as unknown as CompanionClient;
  const store = createCompanionStore({ client, navigate: (a) => navigated.push(a), openSettings: () => calls.push("settings"), now: () => 1_000 });
  return { store, calls, navigated, log };
}

describe("companion slice", () => {
  it("hydrates facts of active missions from their recorded logs", async () => {
    const { store } = setup();
    await store.getState().hydrate(null);
    expect(store.getState().facts.missions[MISSION_ID]).toMatchObject({ title: "Facturation", state: "running" });
  });

  it("accepting a suggestion runs its action and shows the outcome, then navigates", async () => {
    const { store, calls, navigated } = setup({ navigate: { type: "open_approval", approvalId: "a1" } });
    store.getState().applyCompanionEvent({ type: "suggestion", suggestion: suggestion({ type: "open_approval", approvalId: "a1" }) });
    const outcome = await store.getState().respond("accept");
    expect(outcome).toEqual({ ok: true, message: "Carte d'approbation ouverte.", navigate: { type: "open_approval", approvalId: "a1" } });
    expect(store.getState()).toMatchObject({ suggestion: null, bubble: outcome, busy: false });
    expect(navigated).toEqual([{ type: "open_approval", approvalId: "a1" }]);
    expect(calls).toEqual(["act:accept"]);
  });

  it("a stop performed by main is reported with the mission title", async () => {
    const { store } = setup({ performedByMain: true });
    store.getState().applyMissionEvent(new MissionLog().created("Facturation").events[0]!);
    store.getState().applyCompanionEvent({ type: "suggestion", suggestion: suggestion({ type: "stop_mission", missionId: MISSION_ID }) });
    expect((await store.getState().respond("accept")).message).toBe("« Facturation » est arrêtée.");
  });

  it.each([
    ["snooze", "D'accord, je la garde pour plus tard."],
    ["dismiss", "Suggestion écartée."],
    ["mute_kind", "Je ne proposerai plus ce type de signal. Tu peux le réactiver dans les réglages du compagnon."],
  ] as const)("%s ends in a visible outcome", async (response, message) => {
    const { store } = setup();
    store.getState().applyCompanionEvent({ type: "suggestion", suggestion: suggestion({ type: "open_approval", approvalId: "a1" }) });
    await store.getState().respond(response);
    expect(store.getState().bubble?.message).toBe(message);
  });

  it("an IPC failure is an outcome too, never a silent click", async () => {
    const { store } = setup(new NovaIpcError({ code: "unavailable", message: "x" }));
    store.getState().applyCompanionEvent({ type: "suggestion", suggestion: suggestion({ type: "open_approval", approvalId: "a1" }) });
    await expect(store.getState().respond("accept")).resolves.toMatchObject({ ok: false, reason: "unavailable" });
    expect(store.getState().bubble?.ok).toBe(false);
  });

  it("menu actions go through the same executor: stop, quiet, settings, watch without contract", async () => {
    const { store, calls } = setup();
    await store.getState().run({ type: "stop_mission", missionId: MISSION_ID });
    expect(calls).toContain("missions.stop");
    await store.getState().run({ type: "quiet", until: 61_000 });
    expect(store.getState().quietUntil).toBe(61_000);
    await store.getState().run({ type: "watch_command", sourceRef: { kind: "terminal", sessionId: "s" } });
    expect(store.getState().bubble).toMatchObject({ ok: false, reason: "unavailable" });
    await store.getState().run({ type: "open_settings" });
    expect(calls).toContain("settings");
  });

  it("a mission end records the outcome for the success/error pose; cleared suggestions disappear", () => {
    const { store } = setup();
    const log = new MissionLog().created("Facturation").started();
    log.add("mission.succeeded", { summary: "ok" });
    for (const event of log.events) store.getState().applyMissionEvent(event);
    expect(store.getState().missionOutcome).toMatchObject({ kind: "success", title: "Facturation" });
    store.getState().applyCompanionEvent({ type: "suggestion", suggestion: suggestion({ type: "open_approval", approvalId: "a1" }) });
    store.getState().applyCompanionEvent({ type: "suggestion.cleared", suggestionId: "sug-1" });
    expect(store.getState().suggestion).toBeNull();
  });
});
