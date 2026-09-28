// Terminal sessions of the pty-host: one pseudo-terminal per session, a bounded scrollback, at most
// one attached renderer port, coalesced output and credit-based flow control
// (packages/shared/src/terminal.ts):
// - output is coalesced for `coalesceMs` or until `coalesceMaxChars`, then posted as one `output`;
// - every posted character is "unacked" until the renderer acks it after xterm rendered it; above
//   `highWatermark` the pty is paused (the child blocks on write), below `lowWatermark` it resumes.
//   Without a port nothing is waiting for acks: the pty runs and only the scrollback keeps output.
// - agent sessions are read-only: renderer input is dropped here (not only hidden in the UI) until
//   `takeOver` hands the session to the user.
// - J2-B L1: an agent PROGRAM session (`startAgent`) also streams its output to main (`onData`,
//   coalesced like the port output) for the process output ring; a MIRROR session has no process:
//   main writes the structured commands it runs into it, and it never accepts input or a takeover.
import {
  TERMINAL_FLOW,
  type TerminalClientMessage,
  type TerminalHostMessage,
  type TerminalSession,
} from "@nova/shared";
import type { PtyAgentStartParams, PtyCreateParams, PtyMirrorOpenParams, PtyResizeParams } from "./protocol";
import { Scrollback } from "./scrollback";

/** Output kept with an exit report (P5): enough for a test runner's summary. */
const EXIT_TAIL_CHARS = 8 * 1024;
import { shellName, type ShellChoice } from "./shell";

export interface Disposable {
  dispose(): void;
}

/** The subset of node-pty's IPty the host uses. */
export interface PtyProcess {
  readonly pid: number;
  onData(listener: (data: string) => void): Disposable;
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): Disposable;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  pause(): void;
  resume(): void;
  kill(signal?: string): void;
}

export interface PtySpawnOptions {
  name: string;
  cols: number;
  rows: number;
  cwd: string;
  env: Record<string, string>;
}

/** `args` as one string = an exact Windows command line (node-pty passes it through unquoted). */
export type PtySpawn = (file: string, args: string[] | string, options: PtySpawnOptions) => PtyProcess;

/** Electron's MessagePortMain shape (what the host needs of it). */
export interface HostPort {
  postMessage(message: TerminalHostMessage): void;
  on(event: "message", listener: (event: { data: unknown }) => void): unknown;
  on(event: "close", listener: () => void): unknown;
  start(): void;
  close(): void;
}

export type PtyErrorReason = "not_found" | "invalid" | "failed";

export class PtyHostError extends Error {
  constructor(
    readonly reason: PtyErrorReason,
    message: string,
  ) {
    super(message);
    this.name = "PtyHostError";
  }
}

export interface PtySessionsDeps {
  spawn: PtySpawn;
  /** Absolute, confined working directory (see ./cwd). */
  resolveCwd(root: string, cwd: string): Promise<string>;
  shell(): ShellChoice;
  env(): Record<string, string>;
  /** Environment of an agent program: scrubbed like structured commands, plus checked extras. */
  agentEnv(extra: Readonly<Record<string, string>>): Record<string, string>;
  /** Ends the whole process tree of a session; resolves when every process was signalled. */
  killTree(pty: PtyProcess): Promise<void>;
  /**
   * `outputTail`: plain end of the output (≤ 8 KB, not redacted: the receiver redacts); `signal`:
   * the signal number that killed the process, or null.
   */
  onExit?(session: TerminalSession, outputTail: string, signal: number | null): void;
  /** Output of streamed agent program sessions only (raw, not redacted: main redacts). */
  onData?(sessionId: string, data: string): void;
  platform?: NodeJS.Platform;
  onUpdate?(session: TerminalSession): void;
  now?(): number;
  highWatermark?: number;
  lowWatermark?: number;
  scrollbackChars?: number;
  coalesceMs?: number;
  coalesceMaxChars?: number;
  /** Exited sessions kept listed (with their exit code) before the oldest are forgotten. */
  maxExited?: number;
  /** Largest `input` message accepted (a paste); bigger ones are dropped. */
  maxInputChars?: number;
}

/** A process-less pty: main writes into it; `kill` ends it (never a real process to signal). */
class MirrorProcess implements PtyProcess {
  readonly pid = 0;
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(event: { exitCode: number; signal?: number }) => void>();
  exitCode: number | null = null;
  private ended = false;

  onData(listener: (data: string) => void): Disposable {
    this.dataListeners.add(listener);
    return { dispose: () => this.dataListeners.delete(listener) };
  }
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): Disposable {
    this.exitListeners.add(listener);
    return { dispose: () => this.exitListeners.delete(listener) };
  }
  write(): void {}
  resize(): void {}
  pause(): void {}
  resume(): void {}
  kill(): void {
    this.end(null);
  }
  emit(data: string): void {
    if (this.ended) return;
    for (const listener of this.dataListeners) listener(data);
  }
  /** Unknown code = ended "by a signal" for the session (exit code null). */
  end(exitCode: number | null): void {
    if (this.ended) return;
    this.ended = true;
    this.exitCode = exitCode;
    for (const listener of this.exitListeners) listener({ exitCode: exitCode ?? 0, signal: exitCode === null ? 1 : 0 });
  }
}

type SessionKind = "shell" | "program" | "mirror";

interface Session {
  info: TerminalSession;
  pty: PtyProcess;
  kind: SessionKind;
  /** Output also goes to main (agent program sessions). */
  stream: boolean;
  scrollback: Scrollback;
  port: HostPort | null;
  unacked: number;
  paused: boolean;
  pending: string;
  flushTimer: ReturnType<typeof setTimeout> | null;
  exitMessage: Extract<TerminalHostMessage, { type: "exit" }> | null;
  disposables: Disposable[];
}

function isClientMessage(value: unknown): value is TerminalClientMessage {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record["type"] === "input") return typeof record["data"] === "string";
  if (record["type"] === "ack") return typeof record["chars"] === "number" && Number.isFinite(record["chars"]);
  return false;
}

export class PtySessions {
  private readonly sessions = new Map<string, Session>();
  private readonly high: number;
  private readonly low: number;

  constructor(private readonly deps: PtySessionsDeps) {
    this.high = deps.highWatermark ?? TERMINAL_FLOW.highWatermark;
    this.low = deps.lowWatermark ?? TERMINAL_FLOW.lowWatermark;
  }

  async create(params: PtyCreateParams, port: HostPort | null): Promise<TerminalSession> {
    if (this.sessions.has(params.id)) throw new PtyHostError("invalid", "session id already used");
    if (params.owner === "agent" && !params.command) throw new PtyHostError("invalid", "agent sessions need a command");
    if (params.owner === "user" && params.command) throw new PtyHostError("invalid", "user sessions run the user's shell");
    const cwd = await this.confinedCwd(params.root, params.cwd);
    const choice: ShellChoice = params.command ? { ...params.command, name: shellName(params.command.file) } : this.deps.shell();
    const env = params.owner === "agent" ? this.deps.agentEnv({}) : this.deps.env();
    const pty = this.spawn(choice.file, choice.args, choice.name, params, cwd, env);
    return this.open(params, pty, { kind: params.command ? "program" : "shell", stream: false, shell: choice.name }, port);
  }

  /** A mission's background program in a read-only session streamed to main. Returns its pid. */
  async startAgent(params: PtyAgentStartParams): Promise<{ session: TerminalSession; pid: number }> {
    if (this.sessions.has(params.id)) throw new PtyHostError("invalid", "session id already used");
    const cwd = await this.confinedCwd(params.root, params.cwd);
    const { file, args, verbatim } = params.command;
    const windowsLine = verbatim && (this.deps.platform ?? process.platform) === "win32";
    const name = shellName(file);
    const pty = this.spawn(file, windowsLine ? args.join(" ") : args, name, params, cwd, this.deps.agentEnv(params.env));
    const session = this.open({ ...params, owner: "agent" }, pty, { kind: "program", stream: true, shell: name }, null);
    return { session, pid: pty.pid };
  }

  /** A process-less agent session showing the structured commands main runs for a mission. */
  async openMirror(params: PtyMirrorOpenParams): Promise<TerminalSession> {
    if (this.sessions.has(params.id)) throw new PtyHostError("invalid", "session id already used");
    await this.confinedCwd(params.root, params.cwd);
    return this.open({ ...params, owner: "agent" }, new MirrorProcess(), { kind: "mirror", stream: false, shell: "nova" }, null);
  }

  writeMirror(sessionId: string, data: string): void {
    const session = this.get(sessionId);
    if (session.kind !== "mirror" || !(session.pty instanceof MirrorProcess)) throw new PtyHostError("invalid", "not a mirror session");
    session.pty.emit(data);
  }

  closeMirror(sessionId: string, exitCode: number | null): void {
    const session = this.get(sessionId);
    if (!(session.pty instanceof MirrorProcess)) throw new PtyHostError("invalid", "not a mirror session");
    session.pty.end(exitCode);
  }

  private async confinedCwd(root: string, cwd: string): Promise<string> {
    return this.deps.resolveCwd(root, cwd).catch((error: unknown) => {
      throw new PtyHostError("invalid", error instanceof Error ? error.message : "invalid working directory");
    });
  }

  private spawn(file: string, args: string[] | string, name: string, params: { cols: number; rows: number }, cwd: string, env: Record<string, string>): PtyProcess {
    try {
      return this.deps.spawn(file, args, { name: "xterm-256color", cols: params.cols, rows: params.rows, cwd, env });
    } catch {
      throw new PtyHostError("failed", `could not start ${name}`);
    }
  }

  private open(
    params: Pick<PtyCreateParams, "id" | "workspaceId" | "cwd" | "cols" | "rows" | "owner" | "missionId" | "title">,
    pty: PtyProcess,
    options: { kind: SessionKind; stream: boolean; shell: string },
    port: HostPort | null,
  ): TerminalSession {
    const session: Session = {
      info: {
        id: params.id,
        workspaceId: params.workspaceId,
        cwd: params.cwd,
        shell: options.shell,
        title: params.title ?? options.shell,
        owner: params.owner,
        missionId: params.missionId,
        cols: params.cols,
        rows: params.rows,
        state: "running",
        exitCode: null,
        createdAt: (this.deps.now ?? Date.now)(),
      },
      pty,
      kind: options.kind,
      stream: options.stream,
      scrollback: new Scrollback(this.deps.scrollbackChars ?? TERMINAL_FLOW.replayMaxChars),
      port: null,
      unacked: 0,
      paused: false,
      pending: "",
      flushTimer: null,
      exitMessage: null,
      disposables: [],
    };
    this.sessions.set(params.id, session);
    session.disposables.push(
      pty.onData((data) => this.onData(session, data)),
      pty.onExit(({ exitCode, signal }) => this.onExit(session, exitCode, signal ?? 0)),
    );
    if (port) this.bindPort(session, port);
    return { ...session.info };
  }

  list(workspaceId: string | null): TerminalSession[] {
    return [...this.sessions.values()]
      .filter((session) => workspaceId === null || session.info.workspaceId === workspaceId)
      .map((session) => ({ ...session.info }))
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  /** Replaces the session's port (one viewer at a time) and replays its scrollback. */
  attach(sessionId: string, port: HostPort): TerminalSession {
    const session = this.get(sessionId);
    this.bindPort(session, port);
    return { ...session.info };
  }

  resize({ sessionId, cols, rows }: PtyResizeParams): void {
    const session = this.get(sessionId);
    session.info.cols = cols;
    session.info.rows = rows;
    if (session.info.state === "running") {
      try {
        session.pty.resize(cols, rows);
      } catch {
        // The process may have exited between the check and the call; the exit event follows.
      }
    }
  }

  /** "Prendre la main": an agent session becomes the user's (input accepted from now on). */
  takeOver(sessionId: string): TerminalSession {
    const session = this.get(sessionId);
    if (session.kind === "mirror") throw new PtyHostError("invalid", "this session shows the commands NOVA runs; it takes no input");
    if (session.info.owner !== "user") {
      session.info.owner = "user";
      this.deps.onUpdate?.({ ...session.info });
    }
    return { ...session.info };
  }

  /**
   * Ends the session's process tree and forgets the session (closing its tab). Idempotent: an
   * unknown id is already gone.
   */
  async kill(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    await this.endProcess(session);
    this.forget(session);
  }

  /** Ends the session's process tree but keeps the session listed with its exit (process_stop). */
  async stop(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) await this.endProcess(session);
  }

  private async endProcess(session: Session): Promise<void> {
    if (session.info.state !== "running") return;
    // A mirror has no process: signalling its pid (0) would hit the host's own process group.
    if (session.pty instanceof MirrorProcess) session.pty.end(null);
    else await this.deps.killTree(session.pty);
  }

  /** Worker shutdown: every process tree is killed. */
  async killAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.kill(id)));
  }

  private get(sessionId: string): Session {
    const session = this.sessions.get(sessionId);
    if (!session) throw new PtyHostError("not_found", "unknown terminal session");
    return session;
  }

  private bindPort(session: Session, port: HostPort): void {
    // Pending output joins the scrollback (and the old viewer) first: the replay below carries it,
    // so posting it again to the new port would print it twice.
    this.flush(session);
    const previous = session.port;
    session.port = port;
    previous?.close();
    port.on("message", (event) => this.onClientMessage(session, port, event.data));
    port.on("close", () => {
      if (session.port !== port) return;
      session.port = null;
      this.setUnacked(session, 0);
    });
    port.start();
    const replay = session.scrollback.text();
    // The replay counts as output: the renderer acks it like any other write.
    this.setUnacked(session, replay.length);
    port.postMessage({ type: "replay", data: replay });
    if (session.exitMessage) port.postMessage(session.exitMessage);
  }

  private onClientMessage(session: Session, port: HostPort, message: unknown): void {
    if (session.port !== port || !isClientMessage(message)) return;
    if (message.type === "ack") {
      this.setUnacked(session, session.unacked - Math.max(0, message.chars));
      return;
    }
    if (session.info.owner !== "user" || session.info.state !== "running") return;
    if (message.data.length > (this.deps.maxInputChars ?? 1_000_000)) return;
    session.pty.write(message.data);
  }

  private onData(session: Session, data: string): void {
    session.pending += data;
    if (session.pending.length >= (this.deps.coalesceMaxChars ?? 65_536)) {
      this.flush(session);
      return;
    }
    session.flushTimer ??= setTimeout(() => this.flush(session), this.deps.coalesceMs ?? 16);
  }

  private flush(session: Session): void {
    if (session.flushTimer) clearTimeout(session.flushTimer);
    session.flushTimer = null;
    const data = session.pending;
    if (data.length === 0) return;
    session.pending = "";
    session.scrollback.push(data);
    if (session.stream) this.deps.onData?.(session.info.id, data);
    if (!session.port) return;
    session.port.postMessage({ type: "output", data });
    this.setUnacked(session, session.unacked + data.length);
  }

  private setUnacked(session: Session, value: number): void {
    session.unacked = Math.max(0, value);
    const running = session.info.state === "running";
    if (!session.port) {
      // Nobody renders: never keep the process blocked on a window that is gone.
      if (session.paused && running) session.pty.resume();
      session.paused = false;
      return;
    }
    if (!session.paused && session.unacked > this.high && running) {
      session.pty.pause();
      session.paused = true;
    } else if (session.paused && session.unacked < this.low) {
      if (running) session.pty.resume();
      session.paused = false;
    }
  }

  private onExit(session: Session, exitCode: number, signal: number): void {
    this.flush(session);
    session.info.state = "exited";
    // Killed by a signal: there is no exit code (unknown stays null).
    session.info.exitCode = signal ? null : exitCode;
    session.exitMessage = { type: "exit", exitCode: session.info.exitCode, signal: signal || null };
    session.port?.postMessage(session.exitMessage);
    if (this.sessions.get(session.info.id) === session) {
      this.deps.onExit?.({ ...session.info }, session.scrollback.plainTail(EXIT_TAIL_CHARS), signal || null);
    }
    this.pruneExited();
  }

  private pruneExited(): void {
    const exited = [...this.sessions.values()].filter((session) => session.info.state === "exited");
    const extra = exited.length - (this.deps.maxExited ?? 20);
    for (const session of exited.slice(0, Math.max(0, extra))) this.forget(session);
  }

  private forget(session: Session): void {
    if (this.sessions.get(session.info.id) !== session) return;
    this.sessions.delete(session.info.id);
    if (session.flushTimer) clearTimeout(session.flushTimer);
    session.flushTimer = null;
    for (const disposable of session.disposables) disposable.dispose();
    const port = session.port;
    session.port = null;
    port?.close();
  }
}
