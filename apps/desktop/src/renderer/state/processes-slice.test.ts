import { describe, expect, it } from "vitest";
import type { MissionProcess } from "@nova/shared";
import { createProcessesStore, interactiveAgentSessions, missionProcesses } from "./processes-slice";

const proc = (id: string, over: Partial<MissionProcess> = {}): MissionProcess => ({
  id,
  missionId: "m1",
  workspaceId: "w1",
  argv: ["pnpm", "dev"],
  cwd: "",
  pid: 1,
  state: "running",
  exitCode: null,
  signal: null,
  startedAt: 1,
  endedAt: null,
  terminalSessionId: null,
  outputChars: 0,
  ...over,
});

describe("processes slice", () => {
  it("replaces only the listed scope and keeps start order", () => {
    const store = createProcessesStore();
    store.getState().setProcesses({ workspaceId: null, missionId: "m1" }, [proc("b", { startedAt: 2 }), proc("a", { startedAt: 1 })]);
    store.getState().setProcesses({ workspaceId: null, missionId: "m2" }, [proc("c", { missionId: "m2", startedAt: 0 })]);
    store.getState().setProcesses({ workspaceId: null, missionId: "m1" }, [proc("d", { startedAt: 5 })]);
    expect(store.getState().processes.map((item) => item.id)).toEqual(["c", "d"]);
    expect(missionProcesses(store.getState().processes, "m1").map((item) => item.id)).toEqual(["d"]);
  });

  it("applies events without reviving an ended process", () => {
    const store = createProcessesStore();
    store.getState().applyEvent({ type: "process.ended", process: proc("a", { state: "stopped", endedAt: 3 }) });
    store.getState().applyEvent({ type: "process.started", process: proc("a") });
    expect(store.getState().processes).toMatchObject([{ id: "a", state: "stopped" }]);
    store.getState().setStopping("a", true);
    expect(store.getState().stopping).toEqual({ a: true });
    store.getState().setStopping("a", false);
    expect(store.getState().stopping).toEqual({});
  });

  it("only running hosted programs can be taken over in the terminal", () => {
    const ids = interactiveAgentSessions([
      proc("a", { terminalSessionId: "t1" }),
      proc("b", { terminalSessionId: "t2", state: "exited", endedAt: 2 }),
      proc("c", { terminalSessionId: null }),
    ]);
    expect([...ids]).toEqual(["t1"]);
  });
});
