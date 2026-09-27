// Terminal IPC group (E13) over the pty-host worker. Main owns three things here:
// - the workspace root (the renderer only names a workspace id and a relative cwd);
// - the data channel: for `create` and `attach`, a MessageChannelMain whose first port goes to the
//   pty-host and whose second port is sent to the window through the port relay (IPC_CHANNELS
//   .portTransfer). Terminal data then flows renderer <-> pty-host without crossing ipcMain;
// - who may type: user sessions come from the renderer, agent sessions only from the mission
//   runtime (`createAgentSession`), read-only until `takeOver`.
import { randomUUID } from "node:crypto";
import type { MessagePortMain } from "electron";
import type { NovaPortEnvelope, TerminalEvent, TerminalSession } from "@nova/shared";
import type { WorkerNotify } from "../../workers/protocol";
import { PTY_EVENTS, PTY_METHODS, type PtyCommand, type PtyCreateParams } from "../../workers/pty/protocol";
import type { MainApi } from "../api";
import { ServiceError } from "../service-error";

type TerminalApi = MainApi["terminal"];

/** What the service needs of the pty-host ManagedWorker (see ../workers.ts). */
export interface PtyWorker {
  request<T = unknown>(method: string, params?: unknown, transfer?: MessagePortMain[]): Promise<T>;
  onNotify(listener: (event: WorkerNotify) => void): () => void;
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

export interface AgentSessionRequest {
  workspaceId: string;
  missionId: string;
  cwd: string;
  command: PtyCommand;
  title: string;
  cols?: number;
  rows?: number;
}

export interface TerminalService extends TerminalApi {
  /** Mission runtime only: a session whose input is refused until the user takes it over. */
  createAgentSession(req: AgentSessionRequest): Promise<TerminalSession>;
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

  const worker = (): PtyWorker => {
    const current = deps.worker();
    if (subscribed !== current) {
      subscribed = current;
      current.onNotify((event) => {
        if (event.method === PTY_EVENTS.update) publish({ type: "session.updated", session: event.params as TerminalSession });
        if (event.method !== PTY_EVENTS.exit) return;
        const { outputTail, ...session } = event.params as TerminalSession & { outputTail?: string };
        for (const listener of exitListeners) listener(session, outputTail ?? "");
        publish({ type: "session.exited", session });
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
      const session = await withPort(params.id, PTY_METHODS.create, params);
      publish({ type: "session.created", session });
      return session;
    },
    list: (req) => worker().request<TerminalSession[]>(PTY_METHODS.list, req),
    attach: (req) => withPort(req.sessionId, PTY_METHODS.attach, req),
    resize: async (req) => {
      await worker().request(PTY_METHODS.resize, req);
    },
    kill: async (req) => {
      await worker().request(PTY_METHODS.kill, req);
    },
    // No port: the window discovers the session with `list` and attaches when it shows it.
    createAgentSession: async (req) => {
      const params = await createParams({
        workspaceId: req.workspaceId,
        cwd: req.cwd,
        cols: req.cols ?? 120,
        rows: req.rows ?? 30,
        owner: "agent",
        missionId: req.missionId,
        title: req.title,
        command: req.command,
      });
      const session = await worker().request<TerminalSession>(PTY_METHODS.create, params);
      publish({ type: "session.created", session });
      return session;
    },
    takeOver: (req) => worker().request<TerminalSession>(PTY_METHODS.takeOver, req),
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
