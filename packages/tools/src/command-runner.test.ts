import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { PROCESS_LIMITS, type ProcessEvent } from "@nova/shared";
import {
  createProcessCommandRunner,
  plainTerminalText,
  scrubCommandEnv,
  type AgentProcessHandlers,
  type AgentProcessRequest,
  type AgentTerminalHost,
} from "./command-runner";

const root = realpathSync(mkdtempSync(join(tmpdir(), "nova-cmd-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const runner = createProcessCommandRunner({
  resolveCwd: async (_ws, cwd) => (cwd === "" ? root : cwd === "outside" ? null : join(root, cwd)),
  env: { PATH: process.env["PATH"], OPENROUTER_API_KEY: "sk-or-v1-secret", NODE_OPTIONS: "--inspect" },
  maxOutputBytes: 1_000,
  killGraceMs: 200,
  backgroundSettleMs: 20_000,
});

const node = process.execPath;
const spec = (argv: string[], extra: Partial<{ cwd: string; timeoutMs: number }> = {}) => ({
  workspaceId: "w",
  missionId: "m",
  argv,
  cwd: extra.cwd ?? "",
  timeoutMs: extra.timeoutMs ?? 10_000,
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Child processes start slowly on a loaded machine: generous per-test timeouts.
describe("process command runner", { timeout: 30_000 }, () => {
  it("runs argv without a shell, in the confined cwd, with a scrubbed env", async () => {
    const script = "console.log(process.cwd(), process.env.OPENROUTER_API_KEY ?? 'nokey', process.env.NODE_OPTIONS ?? 'noopts', '$HOME && echo')";
    const outcome = await runner.run(spec([node, "-e", script]), new AbortController().signal);
    expect(outcome).toMatchObject({ exitCode: 0, timedOut: false, cancelled: false, isolationLevel: "L0" });
    expect(outcome.output.trim()).toBe(`${root} nokey noopts $HOME && echo`);
  });

  it("refuses a cwd outside the workspace and a missing program", async () => {
    await expect(runner.run(spec([node, "-e", ""], { cwd: "outside" }), new AbortController().signal)).rejects.toMatchObject({ code: "outside_workspace" });
    await expect(runner.run(spec(["nova-no-such-program-xyz"]), new AbortController().signal)).rejects.toMatchObject({ code: "not_found" });
  });

  it("keeps only the tail of a huge output", async () => {
    const outcome = await runner.run(spec([node, "-e", "process.stdout.write('x'.repeat(200000) + 'END')"]), new AbortController().signal);
    expect(outcome.output.length).toBeLessThanOrEqual(1_000);
    expect(outcome.output.endsWith("END")).toBe(true);
    expect(outcome).toMatchObject({ truncated: true, outputBytes: 200_003 });
  });

  it.skipIf(process.platform === "win32")("kills the whole process tree on timeout and on abort", async () => {
    // The parent spawns a grandchild that prints its pid and ignores SIGTERM.
    const script = `
      const { spawn } = require("node:child_process");
      const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{}); console.log('grandchild', process.pid); setInterval(()=>{}, 1000)"], { stdio: "inherit" });
      setInterval(() => {}, 1000);`;
    const timed = await runner.run(spec([node, "-e", script], { timeoutMs: 1_000 }), new AbortController().signal);
    expect(timed.timedOut).toBe(true);
    const pid = Number(/grandchild (\d+)/.exec(timed.output)?.[1]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(alive(pid)).toBe(false);

    const controller = new AbortController();
    const pending = runner.run(spec([node, "-e", script]), controller.signal);
    setTimeout(() => controller.abort(), 500);
    const aborted = await pending;
    expect(aborted.cancelled).toBe(true);
  });

  it("starts, lists and stops background processes per mission", async () => {
    const started = await runner.startBackground(spec([node, "-e", "console.log('ready'); setInterval(()=>{},1000)"]));
    expect(started.initialOutput).toContain("ready");
    expect(runner.list("m").map((process) => process.id)).toEqual([started.process.id]);
    await runner.stopAll("m");
    expect(runner.list("m")).toEqual([]);
  });

  it.skipIf(process.platform === "win32")("stopEverything kills background and in-flight runs of every mission, then refuses launches", async () => {
    const own = createProcessCommandRunner({ resolveCwd: async () => root, killGraceMs: 200, backgroundSettleMs: 20_000 });
    const server = await own.startBackground(spec([node, "-e", "console.log('ready'); setInterval(()=>{},1000)"]));
    const other = await own.startBackground({ ...spec([node, "-e", "console.log('ready'); setInterval(()=>{},1000)"]), missionId: "other" });
    const foreground = own.run(spec([node, "-e", "setInterval(()=>{},1000)"], { timeoutMs: 60_000 }), new AbortController().signal);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await own.stopEverything();
    expect(alive(server.process.pid ?? -1)).toBe(false);
    expect(alive(other.process.pid ?? -1)).toBe(false);
    expect((await foreground).signal).not.toBeNull();
    expect(own.list("m")).toEqual([]);
    await expect(own.run(spec([node, "-e", ""]), new AbortController().signal)).rejects.toMatchObject({ code: "cancelled" });
  });

  // Simulated on POSIX: a fake ComSpec prints the argv it receives, one per line.
  it.skipIf(process.platform === "win32")("starts a Windows batch shim (pnpm.cmd) through cmd.exe with escaped arguments", async () => {
    const bin = join(root, "win-bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "pnpm.cmd"), "@echo off\n");
    const comspec = join(root, "fake-cmd.sh");
    writeFileSync(comspec, "#!/bin/sh\nfor a in \"$@\"; do printf '%s\\n' \"$a\"; done\n");
    chmodSync(comspec, 0o755);
    const windows = createProcessCommandRunner({
      resolveCwd: async () => root,
      env: { PATH: `relative-dir${delimiter}${bin}`, PATHEXT: ".COM;.EXE;.BAT;.CMD", ComSpec: comspec },
      platform: "win32",
    });
    const outcome = await windows.run(spec(["pnpm", "test", "a&b"]), new AbortController().signal);
    expect(outcome.output.split("\n").slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    expect(outcome.output).toContain(`"${join(bin, "pnpm.cmd")} ^^^"test^^^" ^^^"a^^^&b^^^""`);
    await expect(windows.run(spec(["pnpm", "a\nb"]), new AbortController().signal)).rejects.toMatchObject({ code: "invalid_arguments" });
    await expect(windows.run(spec(["yarn"]), new AbortController().signal)).rejects.toMatchObject({ code: "not_found" });
  });

  it("refuses secret-looking extra variables", () => {
    expect(() => scrubCommandEnv({}, { GITHUB_TOKEN: "x" })).toThrow(/not allowed/);
    expect(scrubCommandEnv({ PATH: "/bin", AWS_SECRET_ACCESS_KEY: "x", LC_ALL: "C" })).toEqual({ PATH: "/bin", LC_ALL: "C" });
  });
});

/** In-memory agent terminal: records what the runner asks, lets the test drive output and exits. */
function fakeHost(options: { unavailable?: boolean; mirrorGone?: boolean } = {}) {
  const started: { request: AgentProcessRequest; handlers: AgentProcessHandlers; sessionId: string }[] = [];
  const stopped: string[] = [];
  const mirrors: { sessionId: string; missionId: string; data: string; closed: number | null | undefined }[] = [];
  let next = 0;
  const host: AgentTerminalHost = {
    async startProcess(request, handlers) {
      if (options.unavailable) return null;
      const sessionId = `session-${++next}`;
      started.push({ request, handlers, sessionId });
      return { sessionId, pid: 1000 + next };
    },
    async stopProcess(sessionId) {
      stopped.push(sessionId);
      const entry = started.find((item) => item.sessionId === sessionId);
      entry?.handlers.onExit({ exitCode: null, signal: "SIGTERM" });
    },
    async openMirror(request) {
      const sessionId = `mirror-${++next}`;
      mirrors.push({ sessionId, missionId: request.missionId, data: "", closed: undefined });
      return sessionId;
    },
    async writeMirror(sessionId, data) {
      const mirror = mirrors.find((item) => item.sessionId === sessionId);
      if (!mirror || options.mirrorGone) return false;
      mirror.data += data;
      return true;
    },
    async closeMirror(sessionId, exitCode) {
      const mirror = mirrors.find((item) => item.sessionId === sessionId);
      if (mirror) mirror.closed = exitCode;
    },
  };
  return { host, started, stopped, mirrors };
}

const sleeper = [node, "-e", "console.log('ready'); setInterval(()=>{},1000)"];

describe("mission processes (J2-B L1)", { timeout: 30_000 }, () => {
  it("tracks a background process as a MissionProcess: workspace, redacted argv, events, stopped state", async () => {
    const own = createProcessCommandRunner({ resolveCwd: async () => root, killGraceMs: 200, backgroundSettleMs: 20_000 });
    const events: ProcessEvent[] = [];
    own.onProcessEvent((event) => events.push(event));
    const started = await own.startBackground({ ...spec([...sleeper, "sk-or-v1-abcdefghijklmnop"]), workspaceId: "ws-1" });
    const record = own.process(started.process.id);
    expect(record).toMatchObject({ missionId: "m", workspaceId: "ws-1", state: "running", terminalSessionId: null, endedAt: null });
    expect(record?.argv.join(" ")).not.toContain("sk-or-v1-abcdefghijklmnop");
    expect(record?.outputChars).toBeGreaterThan(0);
    await own.stop(started.process.id);
    expect(own.process(started.process.id)).toMatchObject({ state: "stopped", exitCode: null });
    expect(alive(started.process.pid ?? -1)).toBe(false);
    expect(events.map((event) => `${event.type}:${event.process.state}`)).toEqual(["process.started:running", "process.ended:stopped"]);
    // Kept listed (with its output) for the mission view; CommandRunner.list only shows live ones.
    expect(own.processes({ workspaceId: "ws-1", missionId: null }).map((item) => item.id)).toEqual([started.process.id]);
    expect(own.processes({ workspaceId: "other", missionId: null })).toEqual([]);
    expect(own.list("m")).toEqual([]);
  });

  it("bounds and redacts the output tail, and says when older output was dropped", async () => {
    const own = createProcessCommandRunner({ resolveCwd: async () => root, killGraceMs: 200 });
    const script = `process.stdout.write('y'.repeat(${PROCESS_LIMITS.outputRingChars + 50_000})); console.log(' key=sk-or-v1-abcdefghijklmnopqrst done')`;
    const started = await own.startBackground(spec([node, "-e", script]));
    const id = started.process.id;
    await expect.poll(() => own.process(id)?.state, { timeout: 10_000 }).toBe("exited");
    const output = own.output(id, 200);
    expect(output?.text.length).toBeLessThanOrEqual(200);
    expect(output?.text).toContain("done");
    expect(output?.text).not.toContain("sk-or-v1-abcdefghijklmnopqrst");
    expect(output).toMatchObject({ truncated: true, state: "exited", totalChars: PROCESS_LIMITS.outputRingChars + 50_000 + 40 });
    // The API cap applies whatever the caller asks.
    expect(own.output(id, 1_000_000)?.text.length).toBeLessThanOrEqual(PROCESS_LIMITS.outputTailMaxChars);
    expect(own.output("unknown", 10)).toBeNull();
  });

  it("refuses more than maxRunningPerMission background processes for one mission", async () => {
    const { host } = fakeHost();
    const own = createProcessCommandRunner({ resolveCwd: async () => root, terminal: host, backgroundSettleMs: 1 });
    for (let index = 0; index < PROCESS_LIMITS.maxRunningPerMission; index += 1) await own.startBackground(spec(sleeper));
    await expect(own.startBackground(spec(sleeper))).rejects.toMatchObject({ code: "too_large" });
    // Another mission has its own allowance.
    await expect(own.startBackground({ ...spec(sleeper), missionId: "other" })).resolves.toBeDefined();
    const first = own.processes({ workspaceId: null, missionId: "m" })[0];
    await own.stop(first?.id ?? "");
    await expect(own.startBackground(spec(sleeper))).resolves.toBeDefined();
  });

  it("runs a background process in an agent terminal session: resolved program, scrubbed extras, ring fed by the session", async () => {
    const { host, started, stopped } = fakeHost();
    const own = createProcessCommandRunner({
      resolveCwd: async () => root,
      env: { PATH: process.env["PATH"] },
      terminal: host,
      backgroundSettleMs: 20_000,
    });
    const events: ProcessEvent[] = [];
    own.onProcessEvent((event) => events.push(event));
    const pending = own.startBackground(spec(["node", "server.js"]));
    await expect.poll(() => started.length).toBe(1);
    const [session] = started;
    expect(session?.request).toMatchObject({ missionId: "m", cwd: "", env: { CI: "1" }, title: "node server.js" });
    expect(session?.request.program.file).toMatch(/node(\.exe)?$/);
    expect(session?.request.program.args).toEqual(["server.js"]);
    session?.handlers.onData("\u001b[32mready\u001b[0m on :3000\r\n");
    const result = await pending;
    expect(result.initialOutput).toBe("ready on :3000\n");
    expect(own.process(result.process.id)).toMatchObject({ terminalSessionId: "session-1", pid: 1001, state: "running" });
    expect(own.output(result.process.id, 100)?.text).toBe("ready on :3000\n");
    await own.stop(result.process.id);
    expect(stopped).toEqual(["session-1"]);
    expect(own.process(result.process.id)).toMatchObject({ state: "stopped", signal: "SIGTERM" });
    expect(events.map((event) => event.type)).toEqual(["process.started", "process.ended"]);
    await expect(own.startBackground(spec(["nova-no-such-program-xyz"]))).rejects.toMatchObject({ code: "not_found" });
    await expect(own.startBackground({ ...spec(sleeper), env: { API_TOKEN: "x" } })).rejects.toMatchObject({ code: "invalid_arguments" });
  });

  it("reports an unobserved end as unknown, and falls back to a plain child process without a terminal", async () => {
    const { host, started } = fakeHost();
    const own = createProcessCommandRunner({ resolveCwd: async () => root, terminal: host, backgroundSettleMs: 1 });
    const hosted = await own.startBackground(spec(sleeper));
    started[0]?.handlers.onExit({ exitCode: null, signal: null });
    expect(own.process(hosted.process.id)).toMatchObject({ state: "exited", exitCode: null, signal: null });

    const plain = createProcessCommandRunner({ resolveCwd: async () => root, terminal: fakeHost({ unavailable: true }).host, killGraceMs: 200, backgroundSettleMs: 20_000 });
    const child = await plain.startBackground(spec(sleeper));
    expect(child.initialOutput).toContain("ready");
    expect(plain.process(child.process.id)).toMatchObject({ terminalSessionId: null, state: "running" });
    await plain.stopAll("m");
    expect(alive(child.process.pid ?? -1)).toBe(false);
  });

  it("mirrors foreground runs read-only in one agent session per mission, then closes it with the mission", async () => {
    const { host, mirrors } = fakeHost();
    const own = createProcessCommandRunner({ resolveCwd: async () => root, terminal: host });
    const sessions: string[] = [];
    await own.run(spec([node, "-e", "console.log('line one'); console.log('Bearer abcdefghijklmnopqrstuvwxyz')"]), new AbortController().signal, undefined, (id) => sessions.push(id));
    await own.run(spec([node, "-e", "process.exit(3)"]), new AbortController().signal, undefined, (id) => sessions.push(id));
    await expect.poll(() => mirrors[0]?.data ?? "").toContain("[code 3");
    expect(mirrors).toHaveLength(1);
    expect(sessions).toEqual(["mirror-1", "mirror-1"]);
    const text = plainTerminalText(mirrors[0]?.data ?? "");
    expect(text).toContain("$ ");
    expect(text).toContain("line one\n");
    expect(text).not.toContain("abcdefghijklmnopqrstuvwxyz");
    // A bare LF would leave the cursor in its column: the mirror writes CRLF.
    expect(mirrors[0]?.data).not.toMatch(/[^\r]\n/);
    await own.stopAll("m");
    expect(mirrors[0]?.closed).toBe(3);
    // The next command of the mission opens a fresh session.
    await own.run(spec([node, "-e", ""]), new AbortController().signal);
    expect(mirrors).toHaveLength(2);
  });

  it("holds the cap against concurrent starts (a « Chaîne » program's Promise.all)", async () => {
    const { host, started } = fakeHost();
    const own = createProcessCommandRunner({ resolveCwd: async () => root, terminal: host, backgroundSettleMs: 1 });
    const burst = await Promise.allSettled(Array.from({ length: PROCESS_LIMITS.maxRunningPerMission + 4 }, () => own.startBackground(spec(sleeper))));
    expect(burst.filter((result) => result.status === "fulfilled")).toHaveLength(PROCESS_LIMITS.maxRunningPerMission);
    expect(burst.filter((result) => result.status === "rejected").map((result) => (result as PromiseRejectedResult).reason)).toEqual(
      Array.from({ length: 4 }, () => expect.objectContaining({ code: "too_large" })),
    );
    expect(started).toHaveLength(PROCESS_LIMITS.maxRunningPerMission);
    // A start that fails gives its slot back.
    const fresh = createProcessCommandRunner({ resolveCwd: async () => root, terminal: host, backgroundSettleMs: 1 });
    await expect(fresh.startBackground(spec(["nova-no-such-program-xyz"]))).rejects.toMatchObject({ code: "not_found" });
    for (let index = 0; index < PROCESS_LIMITS.maxRunningPerMission; index += 1) await fresh.startBackground(spec(sleeper));
  });

  it("stopAll(mission) also ends that mission's foreground run, and only that mission's", async () => {
    const own = createProcessCommandRunner({ resolveCwd: async () => root, killGraceMs: 200 });
    const pidOf = (text: string): number => Number(/pid=(\d+)/.exec(text)?.[1] ?? -1);
    const script = "console.log('pid=' + process.pid); setInterval(() => {}, 1000)";
    let mine = "";
    let theirs = "";
    const run = own.run(spec([node, "-e", script], { timeoutMs: 60_000 }), new AbortController().signal, (_stream, text) => (mine += text));
    const other = own.run({ ...spec([node, "-e", script], { timeoutMs: 60_000 }), missionId: "other" }, new AbortController().signal, (_stream, text) => (theirs += text));
    await expect.poll(() => pidOf(mine) > 0 && pidOf(theirs) > 0, { timeout: 10_000 }).toBe(true);
    await own.stopAll("m");
    await run;
    expect(alive(pidOf(mine))).toBe(false);
    expect(alive(pidOf(theirs))).toBe(true);
    await own.stopEverything();
    await other;
    expect(alive(pidOf(theirs))).toBe(false);
  });

  it("hands a taken-over session to the user: out of the mission's count, output and stopAll; ended at quit", async () => {
    const { host, started, stopped } = fakeHost();
    const own = createProcessCommandRunner({ resolveCwd: async () => root, terminal: host, backgroundSettleMs: 1 });
    const events: ProcessEvent[] = [];
    own.onProcessEvent((event) => events.push(event));
    const result = await own.startBackground(spec(sleeper));
    started[0]?.handlers.onData("server ready\r\n");
    expect(own.handOver("session-unknown")).toBeNull();
    expect(own.handOver("session-1")).toMatchObject({ id: result.process.id, state: "handed_over", exitCode: null });
    expect(events.at(-1)).toMatchObject({ type: "process.ended", process: { state: "handed_over" } });
    // What the user types and the program echoes never reaches the mission.
    started[0]?.handlers.onData("user typed: hunter2\r\n");
    expect(own.output(result.process.id, 1_000)?.text).toBe("server ready\n");
    expect(own.list("m")).toEqual([]);
    await own.stopAll("m");
    expect(stopped).toEqual([]);
    // Its slot is free: the mission may start as many processes again.
    for (let index = 0; index < PROCESS_LIMITS.maxRunningPerMission; index += 1) await own.startBackground(spec(sleeper));
    await own.stopEverything();
    expect(stopped).toContain("session-1");
  });

  it("reopens the mirror when the user closed its session", async () => {
    const gone = fakeHost({ mirrorGone: true });
    const own = createProcessCommandRunner({ resolveCwd: async () => root, terminal: gone.host });
    await own.run(spec([node, "-e", "console.log(1)"]), new AbortController().signal);
    await expect.poll(() => gone.mirrors.length).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await own.run(spec([node, "-e", "console.log(2)"]), new AbortController().signal);
    await expect.poll(() => gone.mirrors.length).toBe(2);
  });
});
