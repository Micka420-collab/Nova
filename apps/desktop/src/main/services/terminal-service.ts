// Terminal IPC group (E13) over the pty-host worker. Main owns three things here:
// - the workspace root (the renderer only names a workspace id and a relative cwd);
// - the data channel: for `create` and `attach`, a MessageChannelMain whose first port goes to the
//   pty-host and whose second port is sent to the window through the port relay (IPC_CHANNELS
//   .portTransfer). Terminal data then flows renderer <-> pty-host without crossing ipcMain;
// - who may type: user sessions come from the renderer; agent sessions (read-only until `takeOver`)
//   only from main (J2-B L1, through the processes service):
//   - `startAgentProcess`: a mission's background program (run_command `background: true`) runs
//     in the session; its output is also streamed here for the process output ring;
//   - `openMirror` / `writeMirror` / `closeMirror`: a process-less session where main shows the
//     structured commands (run_command, run_tests) it runs for a mission; never taken over.
import { randomUUID } from "node:crypto";
import type { MessagePortMain } from "electron";
import type { NovaPortEnvelope, TerminalEvent, TerminalSession } from "@nova/shared";
import type { WorkerNotify } from "../../workers/protocol";
import {
  PTY_EVENTS,
  PTY_METHODS,
  type PtyAgentStarted,
  type PtyCommand,
  type PtyCreateParams,
  type PtyDataNotice,
  type PtyExitNotice,
} from "../../workers/pty/protocol";
import type { MainApi } from "../api";
import { ServiceError } from "../service-error";

type TerminalApi = MainApi["terminal"];

/** What the service needs of the pty-host ManagedWorker (see ../workers.ts). */
export interface PtyWorker {
  request<T = unknown>(method: string, params?: unknown, transfer?: MessagePortMain[]): Promise<T>;
  onNotify(listener: (event: WorkerNotify) => void): () => void;
  /** The pty-host died on its own: its sessions (and their shells) are gone. */
  onExit(listener: () => void): () => void;
}

export interface PortPair {
  port1: MessagePortMain;
  port2: MessagePortMain;
}

export interface TerminalServiceDeps {
  /** The pty-host worker, started on first use (`() => pool.get("pty-host")`). */
  worker(): PtyWorker;
  /** Canonical absolute root of an open workspace, or null when the id is unknown or closed. */
  workspaceRoot(workspaceId: string): Promise<string | null> | string | null;
  /**
   * Transfers the renderer end of a data channel to the window (webContents.postMessage on
   * IPC_CHANNELS.portTransfer). Returns false when there is no window to receive it.
   */
  sendPort(envelope: NovaPortEnvelope, port: MessagePortMain): boolean;
  /** Default: `new MessageChannelMain()` (injected in tests). */
  createChannel(): PortPair;
  newId?(): string;
}

export interface AgentProcessStart {
  workspaceId: string;
  missionId: string;
  cwd: string;
  /** Resolved program (no shell); `verbatim` = exact Windows command line in `args`. */
  command: PtyCommand & { verbatim: boolean };
  /** Checked, non-secret extras over the scrubbed environment. */
  env: Record<string, string>;
  title: string;
}

export interface AgentProcessWatch {
  /** Raw output (escapes included), coalesced by the host. */
  onData(data: string): void;
  /** Once: the program ended, the user closed its session, or the host died (then all null). */
  onExit(exitCode: number | null, signal: string | null): void;
}

export interface MirrorOpenRequest {
  workspaceId: string;
  missionId: string;
  cwd: string;
  title: string;
}

const AGENT_COLS = 120;
const AGENT_ROWS = 30;

export interface TerminalService extends TerminalApi {
  /**
   * A mission's background program in a read-only agent session (input refused until the user
   * takes it over). The watch is registered before the start, so no output is missed.
   * null = the pty is unavailable here (node-pty failed to load or to spawn).
   */
  startAgentProcess(req: AgentProcessStart, watch: AgentProcessWatch): Promise<{ session: TerminalSession; pid: number } | null>;
  /** Ends a session's process tree; the session stays listed (ended). Idempotent. */
  stopSession(sessionId: string): Promise<void>;
  /** A read-only session showing the structured commands main runs for a mission. */
  openMirror(req: MirrorOpenRequest): Promise<TerminalSession>;
  /** false = the session is gone (closed by the user). */
  writeMirror(sessionId: string, data: string): Promise<boolean>;
  closeMirror(sessionId: string, exitCode: number | null): Promise<void>;
  /** "Prendre la main": the agent session becomes the user's. */
  takeOver(req: { sessionId: string }): Promise<TerminalSession>;
  /**
   * Process exits (N2 signals, P5 watch): the session and the plain, redacted end of its output
   * (≤ 8 KB). Returns an unsubscribe function.
   */
  onExit(listener: (session: TerminalSession, outputTail: string) => void): () => void;
  /** Sessions created, updated (owner/title) or exited: the `terminal.onEvent` push. */
  onEvent(listener: (event: TerminalEvent) => void): () => void;
}

export function createTerminalService(deps: TerminalServiceDeps): TerminalService {
  const exitListeners = new Set<(session: TerminalSession, outputTail: string) => void>();
  const eventListeners = new Set<(event: TerminalEvent) => void>();
  const publish = (event: TerminalEvent): void => {
    for (const listener of eventListeners) listener(event);
  };
  let subscribed: PtyWorker | null = null;
  const newId = deps.newId ?? randomUUID;
  /** Running sessions the host reported: a host that dies cannot report their end itself. */
  const live = new Map<string, TerminalSession>();
  const track = (session: TerminalSession): TerminalSession => {
    if (session.state === "running") live.set(session.id, session);
    else live.delete(session.id);
    return session;
  };
  /** Agent programs whose output and end feed the processes service. */
  const watches = new Map<string, AgentProcessWatch>();
  const endWatch = (sessionId: string, exitCode: number | null, signal: string | null): void => {
    const watch = watches.get(sessionId);
    watches.delete(sessionId);
    watch?.onExit(exitCode, signal);
  };
  const ended = (session: TerminalSession, outputTail: string, signal: string | null = null): void => {
    live.delete(session.id);
    endWatch(session.id, session.exitCode, signal);
    for (const listener of exitListeners) listener(session, outputTail);
    publish({ type: "session.exited", session });
  };

  const worker = (): PtyWorker => {
    const current = deps.worker();
    if (subscribed !== current) {
      subscribed = current;
      current.onNotify((event) => {
        if (event.method === PTY_EVENTS.update) publish({ type: "session.updated", session: track(event.params as TerminalSession) });
        if (event.method === PTY_EVENTS.data) {
          const { sessionId, data } = event.params as PtyDataNotice;
          watches.get(sessionId)?.onData(data);
          return;
        }
        if (event.method !== PTY_EVENTS.exit) return;
        const { outputTail, signal, ...session } = event.params as PtyExitNotice;
        ended(session, outputTail, signal ?? null);
      });
      // Every shell died with the host: each tab ends (no exit code) instead of looking alive.
      current.onExit(() => {
        for (const session of [...live.values()]) ended({ ...session, state: "exited", exitCode: null }, "");
      });
    }
    return current;
  };

  const rootOf = async (workspaceId: string): Promise<string> => {
    const root = await deps.workspaceRoot(workspaceId);
    if (!root) throw new ServiceError("not_found", "Workspace not found");
    return root;
  };

  /** Runs a pty-host method that takes a data port, then hands the other end to the window. */
  const withPort = async (sessionId: string, method: string, params: unknown): Promise<TerminalSession> => {
    const { port1, port2 } = deps.createChannel();
    let session: TerminalSession;
    try {
      session = await worker().request<TerminalSession>(method, params, [port1]);
    } catch (error) {
      port2.close();
      throw error;
    }
    // Sent after the host confirmed: the renderer never receives a port for a session that failed.
    if (!deps.sendPort({ kind: "terminal", id: sessionId }, port2)) port2.close();
    return session;
  };

  const createParams = async (params: Omit<PtyCreateParams, "id" | "root">): Promise<PtyCreateParams> => {
    const root = await rootOf(params.workspaceId);
    return { ...params, id: newId(), root };
  };

  return {
    create: async (req) => {
      const params = await createParams({ ...req, owner: "user", missionId: null, title: null, command: null });
      const session = track(await withPort(params.id, PTY_METHODS.create, params));
      publish({ type: "session.created", session });
      return session;
    },
    list: async (req) => (await worker().request<TerminalSession[]>(PTY_METHODS.list, req)).map(track),
    attach: async (req) => track(await withPort(req.sessionId, PTY_METHODS.attach, req)),
    resize: async (req) => {
      await worker().request(PTY_METHODS.resize, req);
    },
    kill: async (req) => {
      await worker().request(PTY_METHODS.kill, req);
      live.delete(req.sessionId);
      // A program closed with its tab may be forgotten before its exit was reported: its end is unknown.
      endWatch(req.sessionId, null, null);
    },
    // No port: the window discovers the session with `session.created` and attaches when it shows it.
    startAgentProcess: async (req, watch) => {
      const root = await rootOf(req.workspaceId);
      const id = newId();
      watches.set(id, watch);
      let started: PtyAgentStarted;
      try {
        started = await worker().request<PtyAgentStarted>(PTY_METHODS.startAgent, {
          id,
          workspaceId: req.workspaceId,
          root,
          cwd: req.cwd,
          cols: AGENT_COLS,
          rows: AGENT_ROWS,
          missionId: req.missionId,
          title: req.title,
          command: req.command,
          env: req.env,
        });
      } catch (error) {
        watches.delete(id);
        if (error instanceof ServiceError && error.code === "unavailable") return null;
        throw error;
      }
      const session = track(started.session);
      publish({ type: "session.created", session });
      return { session, pid: started.pid };
    },
    stopSession: async (sessionId) => {
      await worker().request(PTY_METHODS.stop, { sessionId });
    },
    openMirror: async (req) => {
      const root = await rootOf(req.workspaceId);
      const params = { id: newId(), workspaceId: req.workspaceId, root, cwd: req.cwd, cols: AGENT_COLS, rows: AGENT_ROWS, missionId: req.missionId, title: req.title };
      const session = track(await worker().request<TerminalSession>(PTY_METHODS.mirrorOpen, params));
      publish({ type: "session.created", session });
      return session;
    },
    writeMirror: async (sessionId, data) => {
      try {
        await worker().request(PTY_METHODS.mirrorWrite, { sessionId, data });
        return true;
      } catch (error) {
        if (error instanceof ServiceError && error.code === "not_found") return false;
        throw error;
      }
    },
    closeMirror: async (sessionId, exitCode) => {
      await worker().request(PTY_METHODS.mirrorClose, { sessionId, exitCode }).catch((error: unknown) => {
        // Already closed by the user: nothing left to end.
        if (!(error instanceof ServiceError && error.code === "not_found")) throw error;
      });
    },
    takeOver: async (req) => track(await worker().request<TerminalSession>(PTY_METHODS.takeOver, req)),
    onExit: (listener) => {
      // Subscribed to the worker on its first use: registering never starts the pty-host.
      exitListeners.add(listener);
      return () => exitListeners.delete(listener);
    },
    onEvent: (listener) => {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
  };
}
