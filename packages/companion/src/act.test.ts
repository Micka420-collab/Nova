import { describe, expect, it, vi } from "vitest";
import { NovaIpcError, type Mission, type MissionDetail, type MissionState } from "@nova/shared";
import { performNomiAction, type NomiAction, type NomiActionPorts } from "./act";
import { MISSION_ID, MissionLog, approval, commandDisplay } from "./test-events";

function mission(state: MissionState): Mission {
  return {
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
  };
}

function ports(state: MissionState, log = new MissionLog().created().started()): NomiActionPorts & { calls: string[] } {
  const calls: string[] = [];
  const detail = { mission: mission(state), events: log.events } as unknown as MissionDetail;
  return {
    calls,
    missions: {
      get: async () => detail,
      stop: async () => {
        calls.push("missions.stop");
        return mission("cancelled");
      },
      resume: async () => {
        calls.push("missions.resume");
        return mission("running");
      },
    },
    approvals: { list: async () => [approval("appr-1")] },
    watch: async (sessionId) => {
      calls.push(`watch:${sessionId}`);
      return { status: sessionId === "busy" ? "already" : sessionId === "idle" ? "none" : "started", command: ["pnpm", "test"] };
    },
    setQuiet: (until) => calls.push(`quiet:${String(until)}`),
  };
}

describe("performNomiAction", () => {
  it("stops a running mission through missions.stop and says so", async () => {
    const p = ports("running");
    await expect(performNomiAction({ type: "stop_mission", missionId: MISSION_ID }, p)).resolves.toEqual({
      ok: true,
      message: "« Facturation » est arrêtée.",
      navigate: null,
    });
    expect(p.calls).toEqual(["missions.stop"]);
  });

  it("says there is nothing to stop when the mission already ended, without calling stop", async () => {
    const p = ports("succeeded");
    const outcome = await performNomiAction({ type: "stop_mission", missionId: MISSION_ID }, p);
    expect(outcome).toEqual({ ok: false, reason: "nothing_to_do", message: "Rien à arrêter : la mission était déjà terminée." });
    expect(p.calls).toEqual([]);
  });

  it("explains a failed command from the mission log, locally", async () => {
    const log = new MissionLog().created().started();
    log.tool("call-1", "run_command").finished("call-1", commandDisplay(["pnpm", "build"], 2, "error TS2345: bad"), "failed");
    const outcome = await performNomiAction(
      { type: "explain_error", sourceRef: { kind: "tool_call", toolCallId: "call-1", missionId: MISSION_ID } },
      ports("running", log),
    );
    expect(outcome).toMatchObject({
      ok: true,
      explanation: { what: "La commande pnpm build s'est terminée avec le code 2.", evidence: "error TS2345: bad" },
    });
  });

  it("summarizes changes as facts", async () => {
    const log = new MissionLog().created().started();
    log.tool("c", "edit_file").finished("c", {
      kind: "file_change",
      change: "modified",
      path: "src/cart.ts",
      fromPath: null,
      additions: 42,
      deletions: 7,
      checkpointId: null,
    });
    const outcome = await performNomiAction({ type: "show_changes", missionId: MISSION_ID }, ports("succeeded", log));
    expect(outcome.ok && outcome.lines?.map((line) => line.text)).toEqual(["1 fichier modifié (+42 / −7)", "Aucun test lancé"]);
  });

  it("maps typed IPC errors to French outcomes and never throws", async () => {
    const p = ports("running");
    p.missions.get = () => Promise.reject(new NovaIpcError({ code: "unavailable", message: "missions.get is not available yet" }));
    await expect(performNomiAction({ type: "show_changes", missionId: MISSION_ID }, p)).resolves.toEqual({
      ok: false,
      reason: "unavailable",
      message: "Cette action n'est pas encore disponible dans cette version.",
    });
    p.missions.get = () => Promise.reject(new Error("boom with sk-or-v1-secretsecret"));
    const outcome = await performNomiAction({ type: "stop_mission", missionId: MISSION_ID }, p);
    expect(outcome).toMatchObject({ ok: false, reason: "failed" });
    expect(outcome.message).not.toContain("sk-or");
  });

  it("every action type ends in a visible outcome with a non-empty message", async () => {
    const actions: NomiAction[] = [
      { type: "start_mission", workspaceId: "w", mode: "fix", goal: "g" },
      { type: "stop_mission", missionId: MISSION_ID },
      { type: "resume_mission", missionId: MISSION_ID },
      { type: "open_approval", approvalId: "appr-1" },
      { type: "open_approval", approvalId: "gone" },
      { type: "explain_error", sourceRef: { kind: "mission", missionId: MISSION_ID } },
      { type: "explain_error", sourceRef: { kind: "terminal", sessionId: "s" } },
      { type: "explain_error", sourceRef: { kind: "approval", approvalId: "appr-1", missionId: null } },
      { type: "explain_source", source: { kind: "tool", code: "timeout", message: null } },
      { type: "show_changes", missionId: MISSION_ID },
      { type: "open_diff", missionId: MISSION_ID, path: "a.ts" },
      { type: "watch_command", sourceRef: { kind: "terminal", sessionId: "s-1" } },
      { type: "watch_command", sourceRef: { kind: "terminal", sessionId: "busy" } },
      { type: "watch_command", sourceRef: { kind: "terminal", sessionId: "idle" } },
      { type: "watch_command", sourceRef: { kind: "mission", missionId: MISSION_ID } },
      { type: "quiet", until: 10_000 },
      { type: "quiet", until: null },
    ];
    for (const action of actions) {
      const outcome = await performNomiAction(action, ports("running"), 1_000);
      expect({ type: action.type, visible: outcome.message.length > 0 }).toEqual({ type: action.type, visible: true });
    }
  });

  it("never starts a mission blind: start opens the contract card", async () => {
    const p = ports("running");
    const action = { type: "start_mission", workspaceId: "w", mode: "fix", goal: "g" } as const;
    await expect(performNomiAction(action, p)).resolves.toMatchObject({ ok: true, navigate: action });
    expect(p.calls).toEqual([]);
  });

  it("quiet mode goes through the port", async () => {
    const setQuiet = vi.fn<(until: number | null) => void>();
    await performNomiAction({ type: "quiet", until: 5_000 }, { ...ports("running"), setQuiet }, 1_000);
    await performNomiAction({ type: "quiet", until: null }, { ...ports("running"), setQuiet }, 1_000);
    expect(setQuiet.mock.calls).toEqual([[5_000], [null]]);
  });
});
