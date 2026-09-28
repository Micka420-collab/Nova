import type { MessagePortMain } from "electron";
import { describe, expect, it, vi } from "vitest";
import type { NovaPortEnvelope, TerminalSession } from "@nova/shared";
import type { WorkerNotify } from "../../workers/protocol";
import { PTY_EVENTS, PTY_METHODS } from "../../workers/pty/protocol";
import { ServiceError } from "../service-error";
import { createTerminalService, type PtyWorker } from "./terminal-service";

const WORKSPACE = "7a1c1f7e-8f5b-4b87-9d7c-1f0f3f1f0a01";
const SESSION = "0d9b3a52-54c3-4d3f-9b3b-2d1a6c7e8f90";

function fakePort(name: string) {
  return { name, close: vi.fn<() => void>() } as unknown as MessagePortMain & { name: string; close: ReturnType<typeof vi.fn<() => void>> };
}

function setup(options: { fail?: boolean; windowOpen?: boolean; gone?: boolean } = {}) {
  const calls: { method: string; params: unknown; transfer: MessagePortMain[] }[] = [];
  const listeners: ((event: WorkerNotify) => void)[] = [];
  const hostExits: (() => void)[] = [];
  const sent: { envelope: NovaPortEnvelope; port: MessagePortMain }[] = [];
  const channels: { port1: ReturnType<typeof fakePort>; port2: ReturnType<typeof fakePort> }[] = [];
  const session = (params: Record<string, unknown>): TerminalSession => ({
    id: String(params["id"] ?? params["sessionId"]),
    workspaceId: WORKSPACE,
    cwd: "",
    shell: "zsh",
    title: "zsh",
    owner: "user",
    missionId: null,
    cols: 80,
    rows: 24,
    state: "running",
    exitCode: null,
    createdAt: 1,
  });
  const worker: PtyWorker = {
    request: async <T,>(method: string, params: unknown = null, transfer: MessagePortMain[] = []) => {
      calls.push({ method, params, transfer });
      if (options.fail) throw new ServiceError("unavailable", "pty-host: node-pty could not be loaded");
      if (method === PTY_METHODS.list) return [] as T;
      if (method === PTY_METHODS.startAgent) return { session: { ...session(params as Record<string, unknown>), owner: "agent" }, pid: 99 } as T;
      if (options.gone && (method === PTY_METHODS.mirrorWrite || method === PTY_METHODS.mirrorClose)) {
        throw new ServiceError("not_found", "pty-host: unknown terminal session");
      }
      return session(params as Record<string, unknown>) as T;
    },
    onNotify: (listener) => {
      listeners.push(listener);
      return () => {};
    },
    onExit: (listener) => {
      hostExits.push(listener);
      return () => {};
    },
  };
  const getWorker = vi.fn<() => PtyWorker>(() => worker);
  const service = createTerminalService({
    worker: getWorker,
    workspaceRoot: (id) => (id === WORKSPACE ? "/home/u/projet" : null),
    sendPort: (envelope, port) => {
      if (options.windowOpen === false) return false;
      sent.push({ envelope, port });
      return true;
    },
    createChannel: () => {
      const pair = { port1: fakePort(`port1-${channels.length}`), port2: fakePort(`port2-${channels.length}`) };
      channels.push(pair);
      return pair;
    },
    newId: () => SESSION,
  });
  return { service, calls, listeners, hostExits, sent, channels, getWorker };
}

describe("terminal service", () => {
  it("creates a user shell in the workspace root and hands the other port end to the window", async () => {
    const { service, calls, sent, channels } = setup();
    const session = await service.create({ workspaceId: WORKSPACE, cwd: "src", cols: 100, rows: 30 });
    expect(session.id).toBe(SESSION);
    expect(calls).toEqual([
      {
        method: PTY_METHODS.create,
        params: {
          workspaceId: WORKSPACE,
          cwd: "src",
          cols: 100,
          rows: 30,
          owner: "user",
          missionId: null,
          title: null,
          command: null,
          id: SESSION,
          root: "/home/u/projet",
        },
        transfer: [channels[0]?.port1],
      },
    ]);
    expect(sent).toEqual([{ envelope: { kind: "terminal", id: SESSION }, port: channels[0]?.port2 }]);
  });

  it("refuses an unknown workspace without starting the pty-host", async () => {
    const { service, getWorker } = setup();
    const other = "2b7d9a1e-0000-4000-8000-000000000000";
    await expect(service.create({ workspaceId: other, cwd: "", cols: 80, rows: 24 })).rejects.toMatchObject({
      code: "not_found",
    });
    expect(getWorker).not.toHaveBeenCalled();
  });

  it("never sends a port for a session the host refused, and closes it", async () => {
    const { service, sent, channels } = setup({ fail: true });
    await expect(service.create({ workspaceId: WORKSPACE, cwd: "", cols: 80, rows: 24 })).rejects.toMatchObject({
      code: "unavailable",
    });
    expect(sent).toEqual([]);
    expect(channels[0]?.port2.close).toHaveBeenCalled();
  });

  it("attach sends a fresh port for the session; with no window the port is closed", async () => {
    const { service, calls, sent, channels } = setup();
    await service.attach({ sessionId: SESSION });
    expect(calls[0]).toMatchObject({ method: PTY_METHODS.attach, params: { sessionId: SESSION } });
    expect(sent[0]?.envelope).toEqual({ kind: "terminal", id: SESSION });

    const closed = setup({ windowOpen: false });
    await closed.service.attach({ sessionId: SESSION });
    expect(closed.channels[0]?.port2.close).toHaveBeenCalled();
    expect(channels).toHaveLength(1);
  });

  it("starts an agent program session with no port, streams its output to the watch, and reports its end once", async () => {
    const { service, calls, sent, listeners } = setup();
    const missionId = "5c6d7e8f-1111-4222-8333-444455556666";
    const events: unknown[] = [];
    service.onEvent((event) => events.push(event));
    const data: string[] = [];
    const ends: unknown[] = [];
    const started = await service.startAgentProcess(
      { workspaceId: WORKSPACE, missionId, cwd: "", command: { file: "/usr/bin/pnpm", args: ["dev"], verbatim: false }, env: { CI: "1" }, title: "pnpm dev" },
      { onData: (chunk) => data.push(chunk), onExit: (code, signal) => ends.push([code, signal]) },
    );
    expect(started).toMatchObject({ pid: 99, session: { id: SESSION, owner: "agent" } });
    expect(calls[0]).toMatchObject({
      method: PTY_METHODS.startAgent,
      params: { id: SESSION, root: "/home/u/projet", missionId, title: "pnpm dev", env: { CI: "1" }, command: { file: "/usr/bin/pnpm", verbatim: false } },
      transfer: [],
    });
    expect(sent).toEqual([]);
    expect(events).toEqual([{ type: "session.created", session: expect.objectContaining({ id: SESSION, owner: "agent" }) }]);
    for (const listener of listeners) listener({ kind: "notify", method: PTY_EVENTS.data, params: { sessionId: SESSION, data: "ready" } });
    for (const listener of listeners) listener({ kind: "notify", method: PTY_EVENTS.data, params: { sessionId: "someone-else", data: "x" } });
    expect(data).toEqual(["ready"]);
    const exited = { ...started?.session, state: "exited", exitCode: null, outputTail: "", signal: "SIGTERM" };
    for (const listener of listeners) listener({ kind: "notify", method: PTY_EVENTS.exit, params: exited });
    await service.kill({ sessionId: SESSION });
    expect(ends).toEqual([[null, "SIGTERM"]]);
    await service.stopSession(SESSION);
    expect(calls.at(-1)).toMatchObject({ method: PTY_METHODS.stop, params: { sessionId: SESSION } });
    await service.takeOver({ sessionId: SESSION });
    expect(calls.at(-1)).toMatchObject({ method: PTY_METHODS.takeOver, params: { sessionId: SESSION } });
  });

  it("an agent program ends (unknown code) when its tab is closed or the host dies before reporting", async () => {
    const closed = setup();
    const ends: unknown[] = [];
    const request = { workspaceId: WORKSPACE, missionId: SESSION, cwd: "", command: { file: "/bin/x", args: [], verbatim: false }, env: {}, title: "x" };
    await closed.service.startAgentProcess(request, { onData: () => {}, onExit: (code) => ends.push(code) });
    await closed.service.kill({ sessionId: SESSION });
    expect(ends).toEqual([null]);

    const dead = setup();
    const deadEnds: unknown[] = [];
    await dead.service.startAgentProcess(request, { onData: () => {}, onExit: (code) => deadEnds.push(code) });
    for (const listener of dead.hostExits) listener();
    expect(deadEnds).toEqual([null]);
  });

  it("answers null (use a plain process) when the pty is unavailable", async () => {
    const { service } = setup({ fail: true });
    const request = { workspaceId: WORKSPACE, missionId: SESSION, cwd: "", command: { file: "/bin/x", args: [], verbatim: false }, env: {}, title: "x" };
    await expect(service.startAgentProcess(request, { onData: () => {}, onExit: () => {} })).resolves.toBeNull();
  });

  it("opens, writes and closes a mirror session; a session closed by the user reads as gone", async () => {
    const { service, calls } = setup();
    const missionId = "5c6d7e8f-1111-4222-8333-444455556666";
    const mirror = await service.openMirror({ workspaceId: WORKSPACE, missionId, cwd: "", title: "Commandes de Nomi" });
    expect(mirror.id).toBe(SESSION);
    expect(calls[0]).toMatchObject({ method: PTY_METHODS.mirrorOpen, params: { id: SESSION, missionId, title: "Commandes de Nomi", root: "/home/u/projet" } });
    await expect(service.writeMirror(SESSION, "$ pnpm test\r\n")).resolves.toBe(true);
    await service.closeMirror(SESSION, 0);
    expect(calls.at(-1)).toMatchObject({ method: PTY_METHODS.mirrorClose, params: { sessionId: SESSION, exitCode: 0 } });

    const gone = setup({ gone: true });
    await expect(gone.service.writeMirror(SESSION, "x")).resolves.toBe(false);
    await expect(gone.service.closeMirror(SESSION, null)).resolves.toBeUndefined();
  });

  it("forwards exits to listeners; registering does not start the pty-host", async () => {
    const { service, listeners, getWorker } = setup();
    const exits: TerminalSession[] = [];
    service.onExit((session) => exits.push(session));
    expect(getWorker).not.toHaveBeenCalled();
    await service.list({ workspaceId: null });
    const exited = { id: SESSION, state: "exited", exitCode: 1 } as unknown as TerminalSession;
    for (const listener of listeners) listener({ kind: "notify", method: PTY_EVENTS.exit, params: exited });
    for (const listener of listeners) listener({ kind: "notify", method: "other", params: null });
    expect(exits).toEqual([exited]);
  });

  it("ends every running session, visibly, when the pty-host dies on its own", async () => {
    const { service, hostExits } = setup();
    const events: unknown[] = [];
    const exits: TerminalSession[] = [];
    service.onEvent((event) => events.push(event));
    service.onExit((session) => exits.push(session));
    await service.create({ workspaceId: WORKSPACE, cwd: "", cols: 80, rows: 24 });
    for (const listener of hostExits) listener();
    expect(events.at(-1)).toEqual({ type: "session.exited", session: expect.objectContaining({ id: SESSION, state: "exited", exitCode: null }) });
    expect(exits).toEqual([expect.objectContaining({ id: SESSION, state: "exited" })]);
    // Reported once: a later host death has nothing left to end.
    for (const listener of hostExits) listener();
    expect(exits).toHaveLength(1);
  });
});
