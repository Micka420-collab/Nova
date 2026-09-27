import { describe, expect, it } from "vitest";
import { activityForTool } from "./activity";
import { EMPTY_COMPANION_FACTS, currentActivity, focusMission, reduceCompanionFacts, type CompanionFactsState } from "./facts";
import { signalsFromMissionEvent } from "./signals";
import { MISSION_ID, MissionLog, approval, commandDisplay, testsDisplay } from "./test-events";

function replay(log: MissionLog): CompanionFactsState {
  return log.events.reduce(reduceCompanionFacts, EMPTY_COMPANION_FACTS);
}

describe("companion facts from a recorded mission log", () => {
  it("follows the activity of the tool that really runs, and clears it when it finishes", () => {
    const log = new MissionLog().created().started();
    expect(currentActivity(focusMission(replay(log)))).toBe("none");
    log.tool("c1", "edit_file");
    expect(currentActivity(focusMission(replay(log)))).toBe("editing");
    log.finished("c1", { kind: "text", text: "ok" });
    expect(currentActivity(focusMission(replay(log)))).toBe("none");
    log.tool("c2", "run_tests");
    expect(currentActivity(focusMission(replay(log)))).toBe("testing");
  });

  it("a read after a failed test is debugging; a passing run resolves the failure", () => {
    const log = new MissionLog().created().started();
    log.tool("t1", "run_tests").finished("t1", testsDisplay(2, 1, 1), "failed");
    log.tool("r1", "read_file");
    expect(currentActivity(focusMission(replay(log)))).toBe("debugging");
    log.finished("r1", { kind: "text", text: "" });
    log.tool("t2", "run_tests").finished("t2", testsDisplay(3, 0, 0));
    log.tool("r2", "search_text");
    expect(currentActivity(focusMission(replay(log)))).toBe("searching");
  });

  it("tracks title, steps, pending approvals and suspension", () => {
    const log = new MissionLog().created("Facturation").started();
    log.add("mission.plan", {
      summary: "plan",
      tasks: [0, 1, 2].map((seq) => ({
        id: `t${seq}`,
        missionId: MISSION_ID,
        seq,
        title: `étape ${seq}`,
        state: "todo" as const,
        acceptance: { kind: "manual" as const, detail: "" },
      })),
    });
    log.add("task.updated", {
      task: { id: "t1", missionId: MISSION_ID, seq: 1, title: "x", state: "running", acceptance: { kind: "manual", detail: "" } },
    });
    log.add("approval.requested", { approval: approval("a1") });
    let mission = focusMission(replay(log));
    expect(mission).toMatchObject({ title: "Facturation", step: 2, steps: 3, state: "waiting_approval" });
    expect(mission?.pendingApprovals.map((a) => a.id)).toEqual(["a1"]);
    log.add("approval.resolved", { approval: { ...approval("a1"), status: "approved", scope: "once" } });
    log.add("mission.suspended", { reason: "budget", detail: null });
    mission = focusMission(replay(log));
    expect(mission).toMatchObject({ state: "suspended", suspendReason: "budget", pendingApprovals: [] });
  });

  it("maps every builtin tool to an activity", () => {
    expect(activityForTool("read_file")).toBe("reading");
    expect(activityForTool("web_search")).toBe("searching");
    expect(activityForTool("git_commit")).toBe("editing");
    expect(activityForTool("run_command")).toBe("running");
    expect(activityForTool("run_tests")).toBe("testing");
    expect(activityForTool("mcp__github__create-issue")).toBe("running");
  });
});

describe("signal producers", () => {
  it("record failed tests, crashed commands, approvals, budget stops and mission ends — nothing else", () => {
    const log = new MissionLog().created().started();
    log.tool("ok", "run_command").finished("ok", commandDisplay(["ls"], 0, "a b"));
    log.tool("t", "run_tests").finished("t", testsDisplay(1, 1, 1), "failed");
    log.tool("c", "run_command").finished("c", commandDisplay(["node", "x.js", "--token", "sk-or-v1-abcdefghijkl"], 1, "Error sk-or-v1-abcdefghijkl"), "failed");
    log.add("approval.requested", { approval: approval("a1") });
    log.add("mission.suspended", { reason: "user", detail: null });
    log.add("mission.resumed", {});
    log.add("mission.suspended", { reason: "budget", detail: null });
    log.add("mission.failed", { reason: "iteration_limit", detail: null });
    let state = EMPTY_COMPANION_FACTS;
    const produced = log.events.flatMap((event) => {
      state = reduceCompanionFacts(state, event);
      return signalsFromMissionEvent(event, state.missions[MISSION_ID] ?? null);
    });
    expect(produced.map((p) => p.draft.kind)).toEqual(["test_failed", "process_crashed", "approval_pending", "budget_reached", "mission_failed"]);
    const crashed = produced[1]?.draft;
    expect(crashed?.evidence.excerpt).toBe("Error [secret masqué]");
    expect(produced[2]?.draft.evidence.excerpt).toBe("exécuter pnpm install");
    expect(produced[4]?.draft.evidence.excerpt).toBe("la limite d'itérations est atteinte");
    expect(new Set(produced.map((p) => p.key)).size).toBe(produced.length);
  });
});
