// pty-host utilityProcess: owns the node-pty terminal sessions (E13). See ./pty/sessions.ts for
// ports, scrollback and flow control, ./pty/protocol.ts for the methods main calls.
// node-pty is a native N-API addon kept EXTERNAL to the bundle and unpacked from the asar
// (ADR-012), so it is loaded lazily: a load failure answers `unavailable` instead of crashing.
import { constants as osConstants } from "node:os";
import type { MessagePortMain } from "electron";
import type { ZodType } from "zod";
import { redactSecrets } from "@nova/shared";
import { resolveConfinedCwd } from "./pty/cwd";
import { buildAgentPtyEnv, buildPtyEnv } from "./pty/env";
import { killTree } from "./pty/kill-tree";
import {
  PTY_EVENTS,
  PTY_METHODS,
  PtyAgentStartParamsSchema,
  PtyCreateParamsSchema,
  PtyListParamsSchema,
  PtyMirrorCloseParamsSchema,
  PtyMirrorOpenParamsSchema,
  PtyMirrorWriteParamsSchema,
  PtyResizeParamsSchema,
  PtySessionParamsSchema,
} from "./pty/protocol";
import { PtyHostError, PtySessions, type HostPort, type PtyProcess, type PtySpawn } from "./pty/sessions";
import { detectUserShell } from "./pty/shell";
import { serveWorker, WorkerMethodError, type HandlerContext, type WorkerHandler } from "./serve";

type NodePty = typeof import("node-pty");

let nodePty: Promise<NodePty> | null = null;

async function loadNodePty(): Promise<NodePty> {
  nodePty ??= import("node-pty");
  try {
    return await nodePty;
  } catch {
    nodePty = null;
    throw new WorkerMethodError("unavailable", "node-pty could not be loaded");
  }
}

/** Spawns `echo nova-pty-ok` in a real pty and returns what it printed. Diagnostics only. */
async function selfTest(): Promise<{ output: string; exitCode: number }> {
  const pty = await loadNodePty();
  const windows = process.platform === "win32";
  const shell = windows ? "cmd.exe" : "/bin/sh";
  const args = windows ? ["/d", "/c", "echo nova-pty-ok"] : ["-c", "echo nova-pty-ok"];
  const child = pty.spawn(shell, args, { name: "xterm-256color", cols: 80, rows: 24, cwd: process.cwd(), env: buildPtyEnv(process.env) });
  return new Promise((resolve) => {
    let output = "";
    child.onData((data) => {
      output += data;
    });
    child.onExit(({ exitCode }) => resolve({ output: output.trim(), exitCode }));
  });
}

let notify: HandlerContext["notify"] | null = null;
let spawnPty: PtySpawn | null = null;

/** Signal number → name (`SIGTERM`); null when unknown or none. */
function signalName(signal: number | null): string | null {
  if (!signal) return null;
  const entry = Object.entries(osConstants.signals).find(([, value]) => value === signal);
  return entry ? entry[0] : null;
}

const sessions = new PtySessions({
  spawn: (file, args, options) => {
    if (!spawnPty) throw new Error("node-pty not loaded");
    return spawnPty(file, args, options);
  },
  resolveCwd: resolveConfinedCwd,
  shell: () => detectUserShell(process.env, process.platform),
  env: () => buildPtyEnv(process.env),
  agentEnv: (extra) => buildAgentPtyEnv(process.env, extra),
  killTree: (pty: PtyProcess) => {
    if (process.platform === "win32") {
      pty.kill();
      return Promise.resolve();
    }
    return killTree(pty.pid);
  },
  onExit: (session, outputTail, signal) =>
    notify?.(PTY_EVENTS.exit, { ...session, outputTail: redactSecrets(outputTail), signal: signalName(signal) }),
  // Raw output of agent programs: main keeps a bounded ring and redacts whatever it hands out.
  onData: (sessionId, data) => notify?.(PTY_EVENTS.data, { sessionId, data }),
  onUpdate: (session) => notify?.(PTY_EVENTS.update, session),
});

function parse<T>(schema: ZodType<T>, params: unknown): T {
  const result = schema.safeParse(params);
  if (!result.success) throw new WorkerMethodError("invalid_params", "invalid terminal request");
  return result.data;
}

/** The port a request carries: exactly one, or none when `optional` (agent sessions start unseen). */
function portOf(context: HandlerContext, optional: true): HostPort | null;
function portOf(context: HandlerContext): HostPort;
function portOf(context: HandlerContext, optional = false): HostPort | null {
  const port: MessagePortMain | undefined = context.ports[0];
  if (optional && context.ports.length === 0) return null;
  if (context.ports.length !== 1 || !port) throw new WorkerMethodError("invalid_params", "expected one port");
  return port as unknown as HostPort;
}

/** Maps session errors to worker error codes; messages are secret-free by construction. */
function handler(run: (params: unknown, context: HandlerContext) => unknown): WorkerHandler {
  return async (params, context) => {
    notify = context.notify;
    try {
      return await run(params, context);
    } catch (error) {
      if (error instanceof PtyHostError) {
        const code = error.reason === "failed" ? "failed" : error.reason === "not_found" ? "not_found" : "invalid_params";
        throw new WorkerMethodError(code, error.message);
      }
      throw error;
    }
  };
}

serveWorker("pty-host", {
  selftest: () => selfTest(),
  [PTY_METHODS.create]: handler(async (params, context) => {
    const request = parse(PtyCreateParamsSchema, params);
    const port = portOf(context, true);
    try {
      const pty = await loadNodePty();
      spawnPty ??= (file, args, options) => pty.spawn(file, args, options);
      return await sessions.create(request, port);
    } catch (error) {
      port?.close();
      throw error;
    }
  }),
  [PTY_METHODS.list]: handler((params) => sessions.list(parse(PtyListParamsSchema, params).workspaceId)),
  [PTY_METHODS.attach]: handler((params, context) => {
    const { sessionId } = parse(PtySessionParamsSchema, params);
    const port = portOf(context);
    try {
      return sessions.attach(sessionId, port);
    } catch (error) {
      port.close();
      throw error;
    }
  }),
  [PTY_METHODS.resize]: handler((params) => sessions.resize(parse(PtyResizeParamsSchema, params))),
  [PTY_METHODS.kill]: handler((params) => sessions.kill(parse(PtySessionParamsSchema, params).sessionId)),
  [PTY_METHODS.takeOver]: handler((params) => sessions.takeOver(parse(PtySessionParamsSchema, params).sessionId)),
  [PTY_METHODS.startAgent]: handler(async (params) => {
    const request = parse(PtyAgentStartParamsSchema, params);
    const pty = await loadNodePty();
    spawnPty ??= (file, args, options) => pty.spawn(file, args, options);
    return sessions.startAgent(request);
  }),
  [PTY_METHODS.stop]: handler((params) => sessions.stop(parse(PtySessionParamsSchema, params).sessionId)),
  // Mirrors need no node-pty: they work even when the native addon failed to load.
  [PTY_METHODS.mirrorOpen]: handler((params) => sessions.openMirror(parse(PtyMirrorOpenParamsSchema, params))),
  [PTY_METHODS.mirrorWrite]: handler((params) => {
    const { sessionId, data } = parse(PtyMirrorWriteParamsSchema, params);
    sessions.writeMirror(sessionId, data);
  }),
  [PTY_METHODS.mirrorClose]: handler((params) => {
    const { sessionId, exitCode } = parse(PtyMirrorCloseParamsSchema, params);
    sessions.closeMirror(sessionId, exitCode);
  }),
});

// main stops workers with a kill (SIGTERM on POSIX) and waits for the exit: end every session's
// process tree first, so a dev server started in a terminal does not outlive NOVA. A repeated
// SIGTERM must not take the default action (die) halfway through the kill pass.
let shuttingDown = false;
process.on("SIGTERM", () => {
  if (shuttingDown) return;
  shuttingDown = true;
  void sessions.killAll().finally(() => process.exit(0));
});
