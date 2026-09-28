import type { MissionProcess, ProcessOutput } from "@nova/shared";
import { describe, expect, it, vi } from "vitest";
import { memoryFiles } from "./__fixtures__/memory-files";
import type { ProcessApi, ToolDeps } from "./apis";
import type { ToolExecutionContext } from "./index";
import { createToolRegistry } from "./registry";

const WS = "11111111-1111-4111-8111-111111111111";
const MINE = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";
const THEIRS = "44444444-4444-4444-8444-444444444444";

const proc = (id: string, missionId: string, over: Partial<MissionProcess> = {}): MissionProcess => ({
  id,
  missionId,
  workspaceId: WS,
  argv: ["pnpm", "dev"],
  cwd: "",
  pid: 4242,
  state: "running",
  exitCode: null,
  signal: null,
  startedAt: 1,
  endedAt: null,
  terminalSessionId: null,
  outputChars: 12,
  ...over,
});

/** In-memory ProcessApi with the real scoping rule: another mission's process is null. */
function fakeProcesses(records: MissionProcess[], outputText = "ready on http://localhost:5173\n") {
  const stop = vi.fn<ProcessApi["stop"]>(async (missionId, id) => {
    const found = records.find((item) => item.id === id && item.missionId === missionId);
    if (!found) return null;
    if (found.state === "running") Object.assign(found, { state: "stopped", signal: "SIGTERM", endedAt: 2 });
    return { ...found };
  });
  const api: ProcessApi = {
    list: (missionId) => records.filter((item) => item.missionId === missionId).map((item) => ({ ...item })),
    output: (missionId, id, maxChars): ProcessOutput | null => {
      const found = records.find((item) => item.id === id && item.missionId === missionId);
      if (!found) return null;
      return { processId: id, state: found.state, text: outputText.slice(-maxChars), truncated: outputText.length > maxChars, totalChars: outputText.length };
    },
    stop,
  };
  return { api, stop };
}

function context(): ToolExecutionContext {
  return { workspaceId: WS, missionId: "m-1", callId: "c", signal: new AbortController().signal, checkpointId: null, seenVersions: new Map(), missionHosts: null };
}

function setup(processes: ProcessApi | null) {
  const deps: ToolDeps = { files: memoryFiles().api, facts: async () => null, commands: null, git: null, web: null, mcp: null, processes };
  const registry = createToolRegistry({ deps });
  const run = async (name: string, args: unknown) => {
    const parsed = registry.parseArguments(name as "process_list", JSON.stringify(args));
    if (!parsed.ok) throw new Error(parsed.error);
    const executor = registry.get(name);
    if (!executor) throw new Error(`missing ${name}`);
    return executor.execute(parsed.args, context());
  };
  const executor = (name: string) => registry.get(name);
  return { registry, run, executor };
}

describe("process tools", () => {
  it("are never offered while the process tracker is not wired", () => {
    const { registry } = setup(null);
    for (const name of ["process_list", "process_output", "process_stop"]) expect(registry.get(name)).toBeNull();
  });

  it("gives the engine the exact argv process_stop kills, before any effect", async () => {
    const { api, stop } = fakeProcesses([proc(MINE, "m-1", { argv: ["node", "server.js", "--port", "3000"] })]);
    const { executor } = setup(api);
    const stopTool = executor("process_stop");
    expect(stopTool?.operation).toBe("execute");
    expect(await stopTool?.permissionFacts({ processId: MINE }, { workspaceId: WS, missionId: "m-1" })).toEqual([
      { argv: ["node", "server.js", "--port", "3000"] },
    ]);
    // Without the mission scope nothing is known: the bare `execute` is judged (never allowed as routine).
    expect(await stopTool?.permissionFacts({ processId: MINE })).toEqual([{}]);
    expect(stop).not.toHaveBeenCalled();
  });

  it("refuses a process of another mission as not found (facts, output, stop)", async () => {
    const { api, stop } = fakeProcesses([proc(MINE, "m-1"), proc(THEIRS, "m-2")]);
    const { run, executor } = setup(api);
    expect(() => executor("process_stop")?.permissionFacts({ processId: THEIRS }, { workspaceId: WS, missionId: "m-1" })).toThrow(
      expect.objectContaining({ code: "not_found" }),
    );
    const output = await run("process_output", { processId: THEIRS });
    expect(output).toMatchObject({ ok: false, display: { kind: "error", code: "not_found" } });
    expect(output.content).toContain("process_list");
    const stopped = await run("process_stop", { processId: THEIRS });
    expect(stopped).toMatchObject({ ok: false, display: { kind: "error", code: "not_found" } });
    // The API was asked with THIS mission's id: the other mission's process is untouched.
    expect(stop).toHaveBeenCalledWith("m-1", THEIRS);
    const listed = await run("process_list", {});
    expect(listed.content).toContain(MINE);
    expect(listed.content).not.toContain(THEIRS);
    expect(await run("process_output", { processId: OTHER })).toMatchObject({ display: { code: "not_found" } });
  });

  it("returns the output tail as untrusted data, bounded by the tool limit", async () => {
    const { api } = fakeProcesses([proc(MINE, "m-1")], `${"x".repeat(30_000)}END`);
    const { run, registry } = setup(api);
    expect(registry.parseArguments("process_output", JSON.stringify({ processId: MINE, maxChars: 20_001 }))).toMatchObject({ ok: false });
    const result = await run("process_output", { processId: MINE, maxChars: 100 });
    expect(result.ok).toBe(true);
    expect(result.provenance).toMatchObject({ source: "command_output", untrusted: true });
    expect(result.content).toMatch(/<data id="[0-9a-f]+" source="command_output"/);
    expect(result.content).toContain("[last 100 of 30003 characters]");
    expect(result.content).toContain("END");
    expect(result.display).toMatchObject({ kind: "process", action: "output", processes: [{ id: MINE }] });
  });

  it("stops a running process of the mission and reports an already ended one as such", async () => {
    const { api } = fakeProcesses([proc(MINE, "m-1"), proc(OTHER, "m-1", { state: "exited", exitCode: 0, endedAt: 5 })]);
    const { run } = setup(api);
    const stopped = await run("process_stop", { processId: MINE });
    expect(stopped).toMatchObject({ ok: true, display: { kind: "process", action: "stop", processes: [{ id: MINE, state: "stopped" }] } });
    expect(stopped.content).toMatch(/^Stopped: pnpm dev/);
    const again = await run("process_stop", { processId: OTHER });
    expect(again.content).toMatch(/^Already ended/);
    expect(again.content).toContain("exit code 0");
  });

  it("lists this mission's processes with their state", async () => {
    const { api } = fakeProcesses([proc(MINE, "m-1"), proc(OTHER, "m-1", { state: "exited", exitCode: 1, endedAt: 3 })]);
    const { run } = setup(api);
    const result = await run("process_list", {});
    expect(result.content).toContain(`${MINE} [running pid 4242] pnpm dev`);
    expect(result.content).toContain(`${OTHER} [exited (code 1) pid 4242]`);
    expect(result.display).toMatchObject({ kind: "process", action: "list", outputTail: null });
  });
});
