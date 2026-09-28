import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { ProcessEvent, TerminalSession } from "@nova/shared";
import { createToolRegistry, type ToolDeps, type ToolExecutionContext } from "@nova/tools";
import { createProcessesService, type ProcessesServiceDeps } from "./processes-service";
import type { AgentProcessWatch } from "./terminal-service";

const root = realpathSync(mkdtempSync(join(tmpdir(), "nova-proc-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const WS = "7a1c1f7e-8f5b-4b87-9d7c-1f0f3f1f0a01";
const MISSION = "5c6d7e8f-1111-4222-8333-444455556666";
const OTHER_MISSION = "6d7e8f90-2222-4333-8444-555566667777";
const node = process.execPath;
const sleeper = [node, "-e", "console.log('ready'); setInterval(()=>{},1000)"];

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function setup(terminal: ProcessesServiceDeps["terminal"] = null) {
  const journal: unknown[] = [];
  const service = createProcessesService({
    resolveCwd: async (_workspaceId, cwd) => (cwd === "" ? root : null),
    terminal,
    journal: { append: (event) => journal.push(event) },
    mirrorTitle: "Commandes de Nomi",
    runnerOptions: { killGraceMs: 200, backgroundSettleMs: 20_000, env: { PATH: process.env["PATH"] } },
  });
  const events: ProcessEvent[] = [];
  service.onEvent((event) => events.push(event));
  return { service, journal, events };
}

const spec = (argv: string[], missionId = MISSION) => ({ workspaceId: WS, missionId, argv, cwd: "", timeoutMs: 10_000 });

function context(missionId = MISSION, callId = "call-1"): ToolExecutionContext {
  return { workspaceId: WS, missionId, callId, signal: new AbortController().signal, checkpointId: null, seenVersions: new Map(), missionHosts: null, record: () => {} };
}

describe("processes service", { timeout: 30_000 }, () => {
  it("drives process_list / process_output / process_stop end to end, scoped to the calling mission", async () => {
    const { service, journal } = setup();
    const deps: ToolDeps = { files: {} as ToolDeps["files"], facts: async () => null, commands: service.runner, git: null, web: null, mcp: null, processes: service.tools };
    const registry = createToolRegistry({ deps });
    const call = async (name: string, args: unknown, ctx = context()) => {
      const parsed = registry.parseArguments(name as "process_list", JSON.stringify(args));
      if (!parsed.ok) throw new Error(parsed.error);
      return registry.get(name)?.execute(parsed.args, ctx);
    };
    const started = await call("run_command", { argv: [...sleeper, "sk-or-v1-abcdefghijklmnop"], background: true });
    expect(started?.ok).toBe(true);
    const [process] = service.tools.list(MISSION);
    expect(process).toBeDefined();
    const id = process?.id ?? "";

    expect((await call("process_list", {}))?.content).toContain(id);
    expect((await call("process_list", {}, context(OTHER_MISSION)))?.content).toBe("This mission has no background process.");
    const output = await call("process_output", { processId: id });
    expect(output?.content).toContain("ready");
    // Another mission cannot read nor stop it.
    expect(await call("process_output", { processId: id }, context(OTHER_MISSION))).toMatchObject({ ok: false, display: { code: "not_found" } });
    expect(await call("process_stop", { processId: id }, context(OTHER_MISSION))).toMatchObject({ ok: false, display: { code: "not_found" } });
    expect(alive(process?.pid ?? -1)).toBe(true);

    const stopped = await call("process_stop", { processId: id });
    expect(stopped).toMatchObject({ ok: true, display: { kind: "process", action: "stop", processes: [{ id, state: "stopped" }] } });
    expect(alive(process?.pid ?? -1)).toBe(false);
    expect(journal).toEqual([{ type: "process.ended", missionId: MISSION, process: expect.objectContaining({ id, state: "stopped" }) }]);
    // The journaled argv is the redacted one.
    expect(JSON.stringify(journal)).not.toContain("sk-or-v1-abcdefghijklmnop");
  });

  it("serves the IPC group for every mission: list by workspace, output, stop; unknown ids are not_found", async () => {
    const { service, events } = setup();
    const mine = await service.runner.startBackground(spec(sleeper));
    const theirs = await service.runner.startBackground(spec(sleeper, OTHER_MISSION));
    expect((await service.api.list({ workspaceId: WS, missionId: null })).map((item) => item.id)).toEqual([mine.process.id, theirs.process.id]);
    expect((await service.api.list({ workspaceId: null, missionId: OTHER_MISSION })).map((item) => item.id)).toEqual([theirs.process.id]);
    expect((await service.api.output({ processId: mine.process.id, maxChars: 100 })).text).toContain("ready");
    const unknown = "00000000-0000-4000-8000-000000000000";
    await expect(service.api.output({ processId: unknown, maxChars: 10 })).rejects.toMatchObject({ code: "not_found" });
    await expect(service.api.stop({ processId: unknown })).rejects.toMatchObject({ code: "not_found" });
    await expect(service.api.stop({ processId: theirs.process.id })).resolves.toMatchObject({ state: "stopped" });
    // Idempotent.
    await expect(service.api.stop({ processId: theirs.process.id })).resolves.toMatchObject({ state: "stopped" });
    expect(events.map((event) => event.type)).toEqual(["process.started", "process.started", "process.ended"]);
    await service.stopEverything();
    expect(alive(mine.process.pid ?? -1)).toBe(false);
    await expect(service.runner.startBackground(spec(sleeper))).rejects.toMatchObject({ code: "cancelled" });
  });

  it("hosts background processes in the agent terminal and mirrors foreground commands there", async () => {
    const watches: AgentProcessWatch[] = [];
    const mirrorData: string[] = [];
    const session = { id: "8f9a0b1c-3333-4444-8555-666677778888" } as TerminalSession;
    type Terminal = NonNullable<ProcessesServiceDeps["terminal"]>;
    const terminal = {
      startAgentProcess: vi.fn<Terminal["startAgentProcess"]>(async (_request, watch) => {
        watches.push(watch);
        watch.onData("\u001b[1mready\u001b[0m\r\n");
        return { session, pid: 321 };
      }),
      stopSession: vi.fn<Terminal["stopSession"]>(async () => watches[0]?.onExit(null, "SIGHUP")),
      openMirror: vi.fn<Terminal["openMirror"]>(async () => ({ id: "mirror-session" }) as TerminalSession),
      writeMirror: vi.fn<Terminal["writeMirror"]>(async (_id, data) => (mirrorData.push(data), true)),
      closeMirror: vi.fn<Terminal["closeMirror"]>(async () => undefined),
    } satisfies Terminal;
    const { service, journal } = setup(terminal);
    const started = await service.runner.startBackground(spec(["node", "server.js"]));
    expect(started.initialOutput).toBe("ready\n");
    expect(terminal.startAgentProcess).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: WS, missionId: MISSION, cwd: "", env: { CI: "1" }, title: "node server.js", command: expect.objectContaining({ args: ["server.js"], verbatim: false }) }),
      expect.anything(),
    );
    expect(service.tools.list(MISSION)).toMatchObject([{ terminalSessionId: session.id, pid: 321, state: "running" }]);
    await service.tools.stop(MISSION, started.process.id);
    expect(terminal.stopSession).toHaveBeenCalledWith(session.id);
    expect(journal).toEqual([{ type: "process.ended", missionId: MISSION, process: expect.objectContaining({ state: "stopped", signal: "SIGHUP" }) }]);

    const terminals: string[] = [];
    await service.runner.run(spec([node, "-e", "console.log('tests ok')"]), new AbortController().signal, undefined, (id) => terminals.push(id));
    await vi.waitFor(() => expect(mirrorData.join("")).toContain("tests ok\r\n"));
    expect(terminal.openMirror).toHaveBeenCalledWith({ workspaceId: WS, missionId: MISSION, cwd: "", title: "Commandes de Nomi" });
    expect(terminals).toEqual(["mirror-session"]);
    // Mission end (controller → commands.stopAll): the mirror closes with the last exit code.
    await service.runner.stopAll(MISSION);
    expect(terminal.closeMirror).toHaveBeenCalledWith("mirror-session", 0);
  });
});

// The whole main-side chain on a real pseudo-terminal: runner → processes service → terminal
// service → (in-process stand-in of the pty-host worker) → PtySessions + node-pty.
describe.runIf(process.platform !== "win32")("processes service on a real pty", { timeout: 30_000 }, () => {
  it("hosts a background program in an agent session, streams its output, stops its tree; mirrors a foreground run", async () => {
    const { spawn: ptySpawn } = await import("node-pty");
    const { PtySessions } = await import("../../workers/pty/sessions");
    const { resolveConfinedCwd } = await import("../../workers/pty/cwd");
    const { buildAgentPtyEnv, buildPtyEnv } = await import("../../workers/pty/env");
    const { killTree } = await import("../../workers/pty/kill-tree");
    const { PTY_EVENTS, PTY_METHODS } = await import("../../workers/pty/protocol");
    const { createTerminalService } = await import("./terminal-service");
    type Notify = (event: { kind: "notify"; method: string; params: unknown }) => void;
    const notifyListeners: Notify[] = [];
    const notify = (method: string, params: unknown) => notifyListeners.forEach((listener) => listener({ kind: "notify", method, params }));
    const sessions = new PtySessions({
      spawn: (file, args, options) => ptySpawn(file, args, options),
      resolveCwd: resolveConfinedCwd,
      shell: () => ({ file: "/bin/sh", args: [], name: "sh" }),
      env: () => buildPtyEnv(process.env),
      agentEnv: (extra) => buildAgentPtyEnv(process.env, extra),
      killTree: (pty) => killTree(pty.pid, { listProcesses: async () => [], signal: (pid, signal) => { try { process.kill(pid, signal); return true; } catch { return false; } }, graceMs: 200 }),
      onExit: (session, outputTail, signal) => notify(PTY_EVENTS.exit, { ...session, outputTail, signal: signal ? "SIGTERM" : null }),
      onData: (sessionId, data) => notify(PTY_EVENTS.data, { sessionId, data }),
      coalesceMs: 5,
    });
    const methods: Record<string, (params: never) => unknown> = {
      [PTY_METHODS.startAgent]: (params) => sessions.startAgent(params),
      [PTY_METHODS.stop]: (params: { sessionId: string }) => sessions.stop(params.sessionId),
      [PTY_METHODS.mirrorOpen]: (params) => sessions.openMirror(params),
      [PTY_METHODS.mirrorWrite]: (params: { sessionId: string; data: string }) => sessions.writeMirror(params.sessionId, params.data),
      [PTY_METHODS.mirrorClose]: (params: { sessionId: string; exitCode: number | null }) => sessions.closeMirror(params.sessionId, params.exitCode),
    };
    const terminal = createTerminalService({
      worker: () => ({
        request: async <T,>(method: string, params?: unknown) => (await methods[method]?.(params as never)) as T,
        onNotify: (listener) => (notifyListeners.push(listener as Notify), () => {}),
        onExit: () => () => {},
      }),
      workspaceRoot: () => root,
      sendPort: () => false,
      createChannel: () => ({ port1: { close() {} }, port2: { close() {} } }) as never,
    });
    const journal: unknown[] = [];
    const service = createProcessesService({
      resolveCwd: async () => root,
      terminal,
      journal: { append: (event) => journal.push(event) },
      mirrorTitle: "Commandes de Nomi",
      runnerOptions: { backgroundSettleMs: 10_000 },
    });
    const pidFile = join(root, "server.pid");
    const script = `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); console.log('serveur pret'); setInterval(() => {}, 1000)`;
    const started = await service.runner.startBackground({ workspaceId: WS, missionId: MISSION, argv: ["node", "-e", script], cwd: "", timeoutMs: 10_000 });
    expect(started.initialOutput).toContain("serveur pret");
    const [record] = service.tools.list(MISSION);
    expect(record).toMatchObject({ state: "running", terminalSessionId: expect.any(String) });
    expect(sessions.list(null)).toMatchObject([{ id: record?.terminalSessionId, owner: "agent", state: "running", missionId: MISSION }]);
    const pid = Number((await import("node:fs")).readFileSync(pidFile, "utf8"));
    expect(alive(pid)).toBe(true);
    expect(service.tools.output(MISSION, record?.id ?? "", 100)?.text).toContain("serveur pret");

    await service.tools.stop(MISSION, record?.id ?? "");
    expect(alive(pid)).toBe(false);
    expect(service.tools.list(MISSION)).toMatchObject([{ state: "stopped" }]);
    expect(journal).toHaveLength(1);

    const terminals: string[] = [];
    await service.runner.run({ workspaceId: WS, missionId: MISSION, argv: [node, "-e", "console.log('tests ok')"], cwd: "", timeoutMs: 10_000 }, new AbortController().signal, undefined, (id) => terminals.push(id));
    await vi.waitFor(() => expect(sessions.list(null).find((item) => item.id === terminals[0])).toMatchObject({ title: "Commandes de Nomi", owner: "agent", state: "running" }));
    await service.runner.stopAll(MISSION);
    expect(sessions.list(null).find((item) => item.id === terminals[0])).toMatchObject({ state: "exited", exitCode: 0 });
    await sessions.killAll();
  });
});
