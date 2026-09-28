import { describe, expect, it } from "vitest";
import type { MissionProcess } from "@nova/shared";
import { initialProcessesView, reduceProcessesEvent, type ProcessesEvent } from "./processes-view";

const base = { id: "e", missionId: "m", seq: 1, at: 1 };
const proc = (over: Partial<MissionProcess> = {}): MissionProcess => ({
  id: "p1",
  missionId: "m",
  workspaceId: "w",
  argv: ["pnpm", "dev"],
  cwd: "",
  pid: 1,
  state: "running",
  exitCode: null,
  signal: null,
  startedAt: 1,
  endedAt: null,
  terminalSessionId: "t1",
  outputChars: 0,
  ...over,
});

const reduce = (events: ProcessesEvent[]) => events.reduce(reduceProcessesEvent, initialProcessesView());

describe("processes view", () => {
  it("maps each call to its agent terminal and keeps every process in start order with its latest state", () => {
    const view = reduce([
      { ...base, type: "tool.terminal", callId: "c1", sessionId: "t1" },
      { ...base, type: "process.started", process: proc() },
      { ...base, type: "process.started", process: proc({ id: "p2", startedAt: 2 }) },
      { ...base, type: "process.ended", process: proc({ state: "stopped", endedAt: 5, signal: "SIGTERM" }) },
    ]);
    expect(view.terminals).toEqual({ c1: "t1" });
    expect(view.processes.map((item) => `${item.id}:${item.state}`)).toEqual(["p1:stopped", "p2:running"]);
  });

  it("never brings an ended process back to running when its start is journaled after its end", () => {
    const view = reduce([
      { ...base, type: "process.ended", process: proc({ state: "exited", exitCode: 1, endedAt: 2 }) },
      { ...base, type: "process.started", process: proc() },
    ]);
    expect(view.processes).toEqual([proc({ state: "exited", exitCode: 1, endedAt: 2 })]);
  });
});
