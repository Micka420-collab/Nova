// Real pseudo-terminals (node-pty, POSIX) for spawn/kill/env/flow control; a fake pty for the
// read-only and detach rules that need exact control over timing.
import { mkdtemp, mkdir, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn as ptySpawn } from "node-pty";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalHostMessage } from "@nova/shared";
import { resolveConfinedCwd } from "./cwd";
import { buildAgentPtyEnv, buildPtyEnv } from "./env";
import { defaultKillTreeDeps, killTree } from "./kill-tree";
import type { PtyAgentStartParams, PtyCreateParams, PtyMirrorOpenParams } from "./protocol";
import { Scrollback } from "./scrollback";
import { PtySessions, type HostPort, type PtyProcess, type PtySessionsDeps } from "./sessions";
import type { ShellChoice } from "./shell";

const posix = process.platform !== "win32";

class FakePort implements HostPort {
  readonly messages: TerminalHostMessage[] = [];
  closed = false;
  private onMessage: ((event: { data: unknown }) => void) | null = null;
  private onClose: (() => void) | null = null;

  postMessage(message: TerminalHostMessage): void {
    this.messages.push(message);
  }
  on(event: "message" | "close", listener: ((event: { data: unknown }) => void) | (() => void)): this {
    if (event === "message") this.onMessage = listener as (event: { data: unknown }) => void;
    else this.onClose = listener as () => void;
    return this;
  }
  start(): void {}
  close(): void {
    this.closed = true;
  }
  /** Renderer side. */
  send(data: unknown): void {
    this.onMessage?.({ data });
  }
  remoteClosed(): void {
    this.onClose?.();
  }
  output(): string {
    return this.messages.map((m) => (m.type === "exit" ? "" : m.data)).join("");
  }
  outputChars(): number {
    return this.messages.reduce((sum, m) => sum + (m.type === "exit" ? 0 : m.data.length), 0);
  }
  exit(): Extract<TerminalHostMessage, { type: "exit" }> | undefined {
    return this.messages.find((m): m is Extract<TerminalHostMessage, { type: "exit" }> => m.type === "exit");
  }
}

let root: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "nova-pty-")));
  await mkdir(join(root, "src"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function realSessions(shell: ShellChoice, overrides: Partial<PtySessionsDeps> = {}): PtySessions {
  return new PtySessions({
    spawn: (file, args, options) => ptySpawn(file, args, options),
    resolveCwd: resolveConfinedCwd,
    shell: () => shell,
    env: () => buildPtyEnv(process.env),
    agentEnv: (extra) => buildAgentPtyEnv(process.env, extra),
    killTree: (pty) => killTree(pty.pid, { ...defaultKillTreeDeps, graceMs: 200 }),
    ...overrides,
  });
}

function params(overrides: Partial<PtyCreateParams> = {}): PtyCreateParams {
  return {
    id: randomUUID(),
    workspaceId: randomUUID(),
    root,
    cwd: "",
    cols: 80,
    rows: 24,
    owner: "user",
    missionId: null,
    title: null,
    command: null,
    ...overrides,
  };
}

const sh = (script: string): ShellChoice => ({ file: "/bin/sh", args: ["-c", script], name: "sh" });

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe.runIf(posix)("PtySessions with node-pty", () => {
  it("runs the shell in the confined cwd, reports the exit code and replays the scrollback on attach", async () => {
    const sessions = realSessions(sh("echo nova-hello; pwd; exit 3"));
    const port = new FakePort();
    const created = await sessions.create(params({ cwd: "src" }), port);
    expect(created).toMatchObject({ shell: "sh", owner: "user", state: "running", cwd: "src" });

    await vi.waitFor(() => expect(port.exit()).toBeDefined(), { timeout: 5_000 });
    expect(port.output()).toContain("nova-hello");
    expect(port.output()).toContain(join(root, "src"));
    expect(port.exit()).toEqual({ type: "exit", exitCode: 3, signal: null });
    expect(sessions.list(null)).toEqual([expect.objectContaining({ id: created.id, state: "exited", exitCode: 3 })]);

    // A reloaded window: a new port gets the screen back, then the exit.
    const again = new FakePort();
    sessions.attach(created.id, again);
    expect(port.closed).toBe(true);
    expect(again.messages[0]?.type).toBe("replay");
    expect(again.output()).toContain("nova-hello");
    expect(again.exit()).toEqual({ type: "exit", exitCode: 3, signal: null });
  });

  it("refuses a cwd that resolves outside the workspace", async () => {
    const outside = await realpath(await mkdtemp(join(tmpdir(), "nova-outside-")));
    await symlink(outside, join(root, "escape"));
    const sessions = realSessions(sh("true"));
    await expect(sessions.create(params({ cwd: "escape" }), new FakePort())).rejects.toMatchObject({ reason: "invalid" });
    await expect(sessions.create(params({ cwd: "missing" }), new FakePort())).rejects.toMatchObject({ reason: "invalid" });
    expect(sessions.list(null)).toEqual([]);
    await rm(outside, { recursive: true, force: true });
  });

  it("kill ends the whole process tree, background jobs included, and forgets the session", async () => {
    const sessions = realSessions(sh("nohup sleep 300 >/dev/null 2>&1 & echo bg=$!; sleep 300"));
    const port = new FakePort();
    const session = await sessions.create(params(), port);
    await vi.waitFor(() => expect(port.output()).toMatch(/bg=\d+/), { timeout: 5_000 });
    const background = Number(/bg=(\d+)/.exec(port.output())?.[1]);
    expect(alive(background)).toBe(true);

    await sessions.kill(session.id);

    await vi.waitFor(() => expect(alive(background)).toBe(false), { timeout: 5_000 });
    expect(sessions.list(null)).toEqual([]);
    expect(port.closed).toBe(true);
    await expect(sessions.kill(session.id)).resolves.toBeUndefined();
  });

  it("gives the shell a scrubbed environment", async () => {
    const env = buildPtyEnv({
      PATH: process.env["PATH"],
      HOME: "/home/nova",
      LANG: "fr_FR.UTF-8",
      LD_LIBRARY_PATH: "/opt/nova/lib",
      OPENROUTER_API_KEY: "sk-or-v1-secret",
      GITHUB_TOKEN: "ghp_secret",
      NOVA_USER_DATA_DIR: "/data",
      ELECTRON_RUN_AS_NODE: "1",
      NODE_OPTIONS: "--require /evil.js",
      TERM: "dumb",
    });
    const sessions = realSessions({ file: "/usr/bin/env", args: [], name: "env" }, { env: () => env });
    const port = new FakePort();
    await sessions.create(params(), port);
    await vi.waitFor(() => expect(port.exit()).toBeDefined(), { timeout: 5_000 });
    const printed = port.output();
    expect(printed).toContain("TERM=xterm-256color");
    expect(printed).toContain("LD_LIBRARY_PATH=/opt/nova/lib");
    expect(printed).toContain("HOME=/home/nova");
    for (const leaked of ["secret", "NOVA_", "ELECTRON_", "NODE_OPTIONS", "TERM=dumb"]) {
      expect(printed).not.toContain(leaked);
    }
  });

  it("pauses a flooding process until the renderer acks, then resumes it to the end", async () => {
    const high = 20_000;
    const sessions = realSessions(sh("yes nova | head -n 100000; echo done"), {
      highWatermark: high,
      lowWatermark: 2_000,
      coalesceMaxChars: 4_096,
    });
    const port = new FakePort();
    const session = await sessions.create(params(), port);
    await vi.waitFor(() => expect(port.outputChars()).toBeGreaterThan(high), { timeout: 5_000 });
    // No acks: the pty stays paused. Output may overshoot by what was already read, not by 500 KB.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const stalled = port.outputChars();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(port.outputChars()).toBe(stalled);
    expect(stalled).toBeLessThan(high + 70_000);
    expect(port.exit()).toBeUndefined();

    // A renderer that acks everything it receives lets it finish.
    let acked = 0;
    const timer = setInterval(() => {
      const total = port.outputChars();
      port.send({ type: "ack", chars: total - acked });
      acked = total;
    }, 5);
    await vi.waitFor(() => expect(port.exit()).toBeDefined(), { timeout: 20_000 });
    clearInterval(timer);
    expect(port.output()).toContain("done");
    expect(port.outputChars()).toBeGreaterThan(500_000);
    await sessions.kill(session.id);
  }, 30_000);
});

class FakePty implements PtyProcess {
  readonly pid = 4242;
  readonly written: string[] = [];
  paused = false;
  private dataListener: ((data: string) => void) | null = null;
  private exitListener: ((event: { exitCode: number; signal?: number }) => void) | null = null;
  onData(listener: (data: string) => void) {
    this.dataListener = listener;
    return { dispose: () => (this.dataListener = null) };
  }
  onExit(listener: (event: { exitCode: number; signal?: number }) => void) {
    this.exitListener = listener;
    return { dispose: () => (this.exitListener = null) };
  }
  write(data: string): void {
    this.written.push(data);
  }
  resize(): void {}
  pause(): void {
    this.paused = true;
  }
  resume(): void {
    this.paused = false;
  }
  kill(): void {}
  emit(data: string): void {
    this.dataListener?.(data);
  }
  exit(exitCode: number, signal = 0): void {
    this.exitListener?.({ exitCode, signal });
  }
}

function fakeSessions(pty: FakePty, overrides: Partial<PtySessionsDeps> = {}) {
  const exits: unknown[] = [];
  const updates: unknown[] = [];
  const sessions = new PtySessions({
    spawn: () => pty,
    resolveCwd: async () => root,
    shell: () => ({ file: "/bin/zsh", args: [], name: "zsh" }),
    env: () => ({}),
    agentEnv: (extra) => ({ ...extra }),
    killTree: async () => pty.exit(0, 1),
    onExit: (session) => exits.push(session),
    onUpdate: (session) => updates.push(session),
    highWatermark: 100,
    lowWatermark: 10,
    coalesceMaxChars: 50,
    ...overrides,
  });
  return { sessions, exits, updates };
}

describe("PtySessions rules", () => {
  it("drops input to an agent session until the user takes it over", async () => {
    const pty = new FakePty();
    const { sessions, updates } = fakeSessions(pty);
    const port = new FakePort();
    const session = await sessions.create(
      params({ owner: "agent", missionId: randomUUID(), title: "pnpm test", command: { file: "/usr/bin/pnpm", args: ["test"] } }),
      port,
    );
    expect(session).toMatchObject({ owner: "agent", shell: "pnpm", title: "pnpm test" });
    port.send({ type: "input", data: "rm -rf /\r" });
    expect(pty.written).toEqual([]);

    expect(sessions.takeOver(session.id).owner).toBe("user");
    expect(updates).toEqual([expect.objectContaining({ id: session.id, owner: "user" })]);
    port.send({ type: "input", data: "q" });
    expect(pty.written).toEqual(["q"]);
  });

  it("refuses an agent session without a command and a user session with one", async () => {
    const { sessions } = fakeSessions(new FakePty());
    await expect(sessions.create(params({ owner: "agent" }), null)).rejects.toMatchObject({ reason: "invalid" });
    await expect(
      sessions.create(params({ command: { file: "/bin/ls", args: [] } }), null),
    ).rejects.toMatchObject({ reason: "invalid" });
  });

  it("resumes a paused pty when its window goes away; input from a replaced port is ignored", async () => {
    const pty = new FakePty();
    const { sessions } = fakeSessions(pty);
    const first = new FakePort();
    const session = await sessions.create(params(), first);
    pty.emit("x".repeat(60));
    pty.emit("x".repeat(60));
    expect(pty.paused).toBe(true);
    first.remoteClosed();
    expect(pty.paused).toBe(false);

    // Detached: output only feeds the scrollback, nothing pauses.
    pty.emit("y".repeat(500));
    expect(pty.paused).toBe(false);

    const second = new FakePort();
    sessions.attach(session.id, second);
    first.send({ type: "input", data: "stale" });
    second.send({ type: "input", data: "fresh" });
    expect(pty.written).toEqual(["fresh"]);
  });

  it("a reattach while output is pending sends it once, inside the replay", async () => {
    const pty = new FakePty();
    const { sessions } = fakeSessions(pty, { coalesceMs: 10_000 });
    const session = await sessions.create(params(), new FakePort());
    pty.emit("earlier\r\n");
    const second = new FakePort();
    sessions.attach(session.id, second);
    pty.emit("later");
    const third = new FakePort();
    sessions.attach(session.id, third);
    expect(third.messages).toEqual([{ type: "replay", data: "earlier\r\nlater" }]);
    expect(second.messages).toEqual([{ type: "replay", data: "earlier\r\n" }, { type: "output", data: "later" }]);
  });

  it("reports a signal death with an unknown exit code", async () => {
    const pty = new FakePty();
    const { sessions, exits } = fakeSessions(pty);
    const port = new FakePort();
    await sessions.create(params(), port);
    pty.exit(0, 9);
    expect(port.exit()).toEqual({ type: "exit", exitCode: null, signal: 9 });
    expect(exits).toEqual([expect.objectContaining({ state: "exited", exitCode: null })]);
  });
});

function agentParams(overrides: Partial<PtyAgentStartParams> = {}): PtyAgentStartParams {
  return {
    id: randomUUID(),
    workspaceId: randomUUID(),
    root,
    cwd: "",
    cols: 80,
    rows: 24,
    missionId: randomUUID(),
    title: "pnpm dev",
    command: { file: "/usr/bin/pnpm", args: ["dev"], verbatim: false },
    env: { CI: "1" },
    ...overrides,
  };
}

function mirrorParams(overrides: Partial<PtyMirrorOpenParams> = {}): PtyMirrorOpenParams {
  return { id: randomUUID(), workspaceId: randomUUID(), root, cwd: "", cols: 80, rows: 24, missionId: randomUUID(), title: "Commandes", ...overrides };
}

describe("agent program sessions (J2-B L1)", () => {
  it("streams the output to main, stays read-only until taken over, and stop keeps it listed", async () => {
    const pty = new FakePty();
    const data: [string, string][] = [];
    const killed = vi.fn<PtySessionsDeps["killTree"]>(async () => pty.exit(0, 15));
    const exits: unknown[][] = [];
    const { sessions } = fakeSessions(pty, {
      onData: (id, chunk) => data.push([id, chunk]),
      killTree: killed,
      onExit: (...args) => exits.push(args),
      coalesceMs: 1,
    });
    const request = agentParams();
    const { session, pid } = await sessions.startAgent(request);
    expect(session).toMatchObject({ owner: "agent", shell: "pnpm", title: "pnpm dev", missionId: request.missionId });
    expect(pid).toBe(pty.pid);
    pty.emit("ready\r\n");
    await vi.waitFor(() => expect(data).toEqual([[request.id, "ready\r\n"]]));
    const port = new FakePort();
    sessions.attach(request.id, port);
    port.send({ type: "input", data: "q" });
    expect(pty.written).toEqual([]);
    sessions.takeOver(request.id);
    port.send({ type: "input", data: "q" });
    expect(pty.written).toEqual(["q"]);
    await sessions.stop(request.id);
    expect(killed).toHaveBeenCalledOnce();
    expect(sessions.list(null)).toMatchObject([{ id: request.id, state: "exited", exitCode: null }]);
    expect(exits[0]?.[2]).toBe(15);
  });

  it("passes a verbatim Windows command line as one string, and argv everywhere else", async () => {
    const spawned: unknown[] = [];
    const pty = new FakePty();
    const windows = fakeSessions(pty, { platform: "win32", spawn: (_file, args) => (spawned.push(args), pty) }).sessions;
    await windows.startAgent(agentParams({ command: { file: "C:\\Windows\\cmd.exe", args: ["/d", "/s", "/c", '"a ^"b^""'], verbatim: true } }));
    const posixHost = fakeSessions(pty, { platform: "linux", spawn: (_file, args) => (spawned.push(args), pty) }).sessions;
    await posixHost.startAgent(agentParams({ command: { file: "/usr/bin/node", args: ["a b"], verbatim: true } }));
    expect(spawned).toEqual(['/d /s /c "a ^"b^""', ["a b"]]);
  });

  it.runIf(posix)("runs the program without a shell, with the structured-command environment", async () => {
    const data: string[] = [];
    const sessions = realSessions(sh(""), { onData: (_id, chunk) => data.push(chunk) });
    const previous = process.env["OPENROUTER_API_KEY"];
    process.env["OPENROUTER_API_KEY"] = "sk-or-v1-leak";
    try {
      const script = "console.log([process.env.CI, process.env.OPENROUTER_API_KEY ?? 'nokey', process.env.TERM, process.argv[1]].join('|'))";
      await sessions.startAgent(agentParams({ command: { file: process.execPath, args: ["-e", script, "$HOME;x"], verbatim: false } }));
      await vi.waitFor(() => expect(data.join("")).toContain("1|nokey|xterm-256color|$HOME;x"), { timeout: 5_000 });
    } finally {
      if (previous === undefined) delete process.env["OPENROUTER_API_KEY"];
      else process.env["OPENROUTER_API_KEY"] = previous;
      await sessions.killAll();
    }
  });
});

describe("mirror sessions (J2-B L1)", () => {
  it("shows what main writes, refuses input and takeover, and ends with the given code without killing anything", async () => {
    const pty = new FakePty();
    const killed = vi.fn<PtySessionsDeps["killTree"]>(async () => undefined);
    const exits: unknown[][] = [];
    const { sessions } = fakeSessions(pty, { killTree: killed, onExit: (...args) => exits.push(args), coalesceMs: 1 });
    const request = mirrorParams();
    const session = await sessions.openMirror(request);
    expect(session).toMatchObject({ owner: "agent", shell: "nova", title: "Commandes", state: "running" });
    const port = new FakePort();
    sessions.attach(request.id, port);
    sessions.writeMirror(request.id, "$ pnpm test\r\n");
    await vi.waitFor(() => expect(port.output()).toBe("$ pnpm test\r\n"));
    port.send({ type: "input", data: "x" });
    expect(() => sessions.takeOver(request.id)).toThrow(expect.objectContaining({ reason: "invalid" }));
    sessions.closeMirror(request.id, 3);
    expect(port.exit()).toEqual({ type: "exit", exitCode: 3, signal: null });
    expect(exits[0]?.[0]).toMatchObject({ id: request.id, exitCode: 3 });
    // Ending an ended mirror, or killing it, never signals a process (a mirror's pid is 0).
    await sessions.kill(request.id);
    expect(killed).not.toHaveBeenCalled();
    expect(() => sessions.writeMirror(request.id, "late")).toThrow(expect.objectContaining({ reason: "not_found" }));
  });

  it("a stopped mirror ends with an unknown code; writing to a program session is refused", async () => {
    const pty = new FakePty();
    const killed = vi.fn<PtySessionsDeps["killTree"]>(async () => undefined);
    const { sessions } = fakeSessions(pty, { killTree: killed });
    const mirror = mirrorParams();
    await sessions.openMirror(mirror);
    await sessions.stop(mirror.id);
    expect(sessions.list(null)).toMatchObject([{ id: mirror.id, state: "exited", exitCode: null }]);
    expect(killed).not.toHaveBeenCalled();
    const program = agentParams();
    await sessions.startAgent(program);
    expect(() => sessions.writeMirror(program.id, "x")).toThrow(expect.objectContaining({ reason: "invalid" }));
  });
});

describe("Scrollback", () => {
  it("keeps at most maxChars, cut after a line break", () => {
    const scrollback = new Scrollback(20);
    scrollback.push("line one\n");
    scrollback.push("line two\n");
    scrollback.push("line three\n");
    expect(scrollback.length).toBeLessThanOrEqual(20);
    expect(scrollback.text()).toBe("line two\nline three\n");
    scrollback.push("four\n");
    expect(scrollback.text()).toBe("line three\nfour\n");
  });
});
