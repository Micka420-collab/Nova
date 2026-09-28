// J2-B events land in their lane's slice of the mission view, live or replayed identically.
import { describe, expect, it } from "vitest";
import type { Mission, MissionEvent, MissionProcess } from "@nova/shared";
import { makeContract } from "../../test/atelier-fake";
import { applyMissionEvents, applyMissionEvent, type MissionView } from "./timeline";

const MISSION_ID = "00000000-0000-4000-8000-00000000a001";
const CHILD_ID = "00000000-0000-4000-8000-00000000a002";
const mission: Mission = {
  id: MISSION_ID,
  workspaceId: "00000000-0000-4000-8000-00000000b001",
  conversationId: null,
  title: "Serveur",
  goal: "Démarrer le serveur",
  mode: "build",
  state: "running",
  modelId: "vendor/model",
  createdAt: 1,
  startedAt: 1,
  endedAt: null,
  updatedAt: 1,
};
const process: MissionProcess = {
  id: "00000000-0000-4000-8000-00000000c001",
  missionId: MISSION_ID,
  workspaceId: mission.workspaceId,
  argv: ["pnpm", "dev"],
  cwd: "",
  pid: 42,
  state: "running",
  exitCode: null,
  signal: null,
  startedAt: 5,
  endedAt: null,
  terminalSessionId: "00000000-0000-4000-8000-00000000d001",
  outputChars: 0,
};

type Body<T> = T extends unknown ? Omit<T, "id" | "seq" | "at" | "missionId"> : never;
let seq = 0;
const ev = (body: Body<MissionEvent>): MissionEvent => {
  seq += 1;
  return { id: `e-${seq}`, seq, at: 100 + seq, missionId: MISSION_ID, ...body } as MissionEvent;
};

describe("J2-B slices of the mission view", () => {
  it("projects each lane's events into its own slice", () => {
    const created = applyMissionEvent(undefined, ev({ type: "mission.created", mission, contract: makeContract(mission.workspaceId) })) as MissionView;
    const link = {
      childMissionId: CHILD_ID, parentMissionId: MISSION_ID, kind: "submission" as const, forkSeq: null, depth: 1,
      reservedUsd: 0.1, worktree: "wt", integration: "pending" as const, createdAt: 1, updatedAt: 1,
    };
    const view = applyMissionEvents(created, [
      ev({ type: "process.started", process }),
      ev({ type: "process.ended", process: { ...process, state: "stopped", endedAt: 9 } }),
      ev({ type: "skill.loaded", ref: "builtin:comprendre-un-depot", name: "comprendre-un-depot", path: null, chars: 1200 }),
      ev({ type: "chain.started", callId: "c1", programPreview: "await nova.read_file({path:'a'})" }),
      ev({ type: "chain.finished", summary: { callId: "c1", state: "succeeded", toolCalls: 1, durationMs: 3, error: null } }),
      ev({ type: "submission.started", link, title: "Tests" }),
      ev({ type: "submission.updated", link: { ...link, integration: "integrated" }, childState: "succeeded" }),
      ev({ type: "continuation.round", round: 1, maxRounds: 3, unprovenTaskIds: ["t1"] }),
      ev({ type: "continuation.stopped", reason: "proven", rounds: 1 }),
    ]);
    expect(view.harness.processes.processes).toMatchObject([{ id: process.id, state: "stopped" }]);
    expect(view.harness.skills.loaded.map((item) => item.name)).toEqual(["comprendre-un-depot"]);
    expect(view.harness.chain.runs).toMatchObject([{ callId: "c1", summary: { state: "succeeded" } }]);
    expect(view.harness.submissions.children).toMatchObject([{ childState: "succeeded", link: { integration: "integrated" } }]);
    expect(view.harness.continuation).toMatchObject({ rounds: [{ round: 1 }], stopped: { reason: "proven" } });
    // J2-A projections are untouched by J2-B events.
    expect(view.items).toEqual(created.items);
  });
});
