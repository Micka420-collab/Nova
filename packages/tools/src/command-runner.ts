// L0 process execution for run_command / run_tests (A3, S3): argv without a shell, cwd resolved
// and contained by the injected resolver, scrubbed environment, timeout, bounded output kept in
// memory (tail), and the whole process tree killed on stop/timeout (POSIX process group, Windows
// `taskkill /T`). Host-agnostic: main or the pty-host instantiates it.
//
// J2-B L1 — background processes are tracked as `MissionProcess` records (workspace, mission,
// redacted argv, state, output ring of PROCESS_LIMITS.outputRingChars, never stored on disk) and
// reported as `ProcessEvent`s. With an `AgentTerminalHost` (the pty-host in the app):
// - a background process runs in a read-only agent terminal session (same argv, no shell, confined
//   cwd, scrubbed env) that the user can take over; its output also feeds the ring;
// - a foreground command keeps the structured execution below and is mirrored, read-only, in one
//   agent session per mission (`onTerminal` reports that session for the `tool.terminal` event).
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { delimiter, extname, isAbsolute, join } from "node:path";
import {
  PROCESS_LIMITS,
  SECRET_ENV_NAME,
  TOOL_LIMITS,
  redactSecrets,
  scrubChildEnv,
  type IsolationLevel,
  type MissionProcess,
  type ProcessEvent,
  type ProcessOutput,
  type RelativePath,
} from "@nova/shared";
import type { BackgroundProcess, CommandOutcome, CommandOutputListener, CommandRunner, CommandSpec } from "./apis";
import { ToolFailure } from "./content";

/** Allowlisted, credential-free environment for project commands (no NOVA_*, ELECTRON_*, NODE_OPTIONS). */
export function scrubCommandEnv(
  env: Readonly<Record<string, string | undefined>>,
  extra: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const result = scrubChildEnv(env);
  Object.assign(result, checkedExtraEnv(extra));
  return result;
}

/** Extra variables of a command: a secret-looking name is refused, never passed on. */
function checkedExtraEnv(extra: Readonly<Record<string, string>>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(extra)) {
    if (SECRET_ENV_NAME.test(name)) throw new ToolFailure("invalid_arguments", `environment variable ${name} is not allowed`);
    result[name] = value;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Windows program resolution. libuv only appends .com/.exe and Node refuses to spawn a .cmd/.bat
// without a shell (CVE-2024-27980), so `pnpm`, `npm`, `npx`, `yarn` (batch shims) would never
// start. The program is resolved here through PATH + PATHEXT, and a batch file runs through
// `cmd.exe /d /s /c` with every argument escaped (the scheme of cross-spawn, see qntm.org/cmd).

/** cmd.exe metacharacters, escaped with `^`. */
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

/**
 * MSVCRT quoting, then cmd escaping applied twice: package-manager shims re-expand their `%*`
 * through cmd once more. Tradeoff: a hand-written batch file that reads `%1` sees the extra `^`.
 */
function escapeBatchArgument(arg: string): string {
  const quoted = `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1")}"`;
  return quoted.replace(CMD_META, "^$1").replace(CMD_META, "^$1");
}

async function isFile(path: string): Promise<boolean> {
  return stat(path).then((info) => info.isFile(), () => false);
}

async function isExecutableFile(path: string): Promise<boolean> {
  return (await isFile(path)) && access(path, constants.X_OK).then(() => true, () => false);
}

/**
 * Absolute path of `program` as Windows would run it (PATHEXT), or null. Only ABSOLUTE PATH entries
 * are searched: a relative entry, like Windows' implicit current directory, is the workspace.
 */
async function resolveWindowsProgram(program: string, cwd: string, env: Readonly<Record<string, string | undefined>>): Promise<string | null> {
  const extensions = (env["PATHEXT"] ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean).map((ext) => ext.toLowerCase());
  const variants = (base: string): string[] => [...(extensions.includes(extname(base).toLowerCase()) ? [base] : []), ...extensions.map((ext) => base + ext)];
  const bases = /[\\/]/.test(program)
    ? [isAbsolute(program) ? program : join(cwd, program)]
    : (env["PATH"] ?? env["Path"] ?? "").split(delimiter).filter((dir) => isAbsolute(dir)).map((dir) => join(dir, program));
  for (const base of bases) {
    for (const candidate of variants(base)) if (await isFile(candidate)) return candidate;
  }
  return null;
}

/**
 * POSIX, pty-hosted processes only: a pty spawn of a missing program "succeeds" (fork) and exits
 * later, so the program is resolved first to report `not_found` like the structured runner.
 */
async function resolvePosixProgram(program: string, cwd: string, env: Readonly<Record<string, string | undefined>>): Promise<string | null> {
  if (program.includes("/")) {
    const path = isAbsolute(program) ? program : join(cwd, program);
    return (await isExecutableFile(path)) ? path : null;
  }
  for (const dir of (env["PATH"] ?? "").split(delimiter)) {
    if (!isAbsolute(dir)) continue;
    const candidate = join(dir, program);
    if (await isExecutableFile(candidate)) return candidate;
  }
  return null;
}

/** What to spawn for argv on Windows: the resolved executable, or cmd.exe running a batch file. */
async function windowsInvocation(
  argv: readonly [string, ...string[]],
  cwd: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<AgentProgram> {
  const [program, ...args] = argv;
  const resolved = await resolveWindowsProgram(program, cwd, env);
  if (resolved === null) throw new ToolFailure("not_found", `program "${program}" was not found on PATH`);
  if (!/\.(cmd|bat)$/i.test(resolved)) return { file: resolved, args, verbatim: false };
  // cmd cannot carry a line break (or NUL) inside an argument: it would end the command.
  if (args.some((arg) => /[\r\n\0]/.test(arg))) {
    throw new ToolFailure("invalid_arguments", `"${program}" is a batch file: its arguments cannot contain line breaks`);
  }
  const line = [resolved.replace(CMD_META, "^$1"), ...args.map(escapeBatchArgument)].join(" ");
  return { file: env["ComSpec"] ?? env["COMSPEC"] ?? "cmd.exe", args: ["/d", "/s", "/c", `"${line}"`], verbatim: true };
}

// ---------------------------------------------------------------------------
// Agent terminal (pty-host in the app)

/** A resolved program: `verbatim` = Windows command line already quoted (cmd.exe running a batch file). */
export interface AgentProgram {
  file: string;
  args: string[];
  verbatim: boolean;
}

export interface AgentProcessRequest {
  workspaceId: string;
  missionId: string;
  /** Workspace-relative; the host resolves and confines it again (S2). */
  cwd: RelativePath;
  program: AgentProgram;
  /** Non-secret variables added to the host's scrubbed environment (names already checked). */
  env: Record<string, string>;
  /** Tab title (redacted argv). */
  title: string;
}

export interface AgentProcessExit {
  /** null when the process was killed by a signal or its end was not observed. */
  exitCode: number | null;
  signal: string | null;
}

export interface AgentProcessHandlers {
  /** Raw terminal output (escape sequences included). May be called before `startProcess` resolves. */
  onData(data: string): void;
  /** Called exactly once, also when the host died. */
  onExit(exit: AgentProcessExit): void;
}

/** Where agent commands are shown (and background processes hosted): the pty-host in the app. */
export interface AgentTerminalHost {
  /**
   * Starts the program in a new agent session, read-only until the user takes it over.
   * null = no terminal here (pty unavailable): the runner then uses a plain child process.
   */
  startProcess(request: AgentProcessRequest, handlers: AgentProcessHandlers): Promise<{ sessionId: string; pid: number | null } | null>;
  /** Kills the session's process tree (the session stays listed as ended). Idempotent. */
  stopProcess(sessionId: string): Promise<void>;
  /** Read-only session that shows the mission's structured commands; null = unavailable. */
  openMirror(request: { workspaceId: string; missionId: string; cwd: RelativePath }): Promise<string | null>;
  /** false = the session is gone (closed by the user): the next command opens a new one. */
  writeMirror(sessionId: string, data: string): Promise<boolean>;
  closeMirror(sessionId: string, exitCode: number | null): Promise<void>;
}

// ---------------------------------------------------------------------------

export interface ProcessCommandRunnerOptions {
  /** Absolute cwd for a workspace-relative path, or null when it escapes the root (S2). */
  resolveCwd(workspaceId: string, cwd: string): Promise<string | null>;
  /** Environment to scrub (default process.env). */
  env?: Readonly<Record<string, string | undefined>>;
  /** Bytes of output kept in memory per foreground run (default TOOL_LIMITS.commandOutputMaxBytes). */
  maxOutputBytes?: number;
  /** Grace period between SIGTERM and SIGKILL. */
  killGraceMs?: number;
  /** Longest wait of startBackground for a first output (it returns earlier once output arrived). */
  backgroundSettleMs?: number;
  platform?: NodeJS.Platform;
  /** Agent terminal (pty-host); absent = plain child processes, no terminal. */
  terminal?: AgentTerminalHost | null;
  /** Mirror failures (never thrown: the command itself is unaffected). Secret-free messages. */
  onTerminalError?(error: unknown): void;
  now?(): number;
}

/** Last `max` characters of a process's combined output (terminal escapes included when pty-hosted). */
class OutputRing {
  private text = "";
  total = 0;
  dropped = false;
  constructor(private readonly max: number) {}
  push(chunk: string): void {
    this.total += chunk.length;
    this.text += chunk;
    // Trimmed in steps (not on every chunk): slicing 200 000 characters per small chunk would be quadratic.
    if (this.text.length > this.max + (this.max >> 2)) {
      this.text = this.text.slice(this.text.length - this.max);
      this.dropped = true;
    }
  }
  value(): string {
    if (this.text.length <= this.max) return this.text;
    this.dropped = true;
    return this.text.slice(this.text.length - this.max);
  }
}

/** Keeps the last `max` characters of a stream. */
class OutputTail {
  private text = "";
  bytes = 0;
  truncated = false;
  constructor(private readonly max: number) {}
  push(chunk: string, byteLength: number): void {
    this.bytes += byteLength;
    this.text += chunk;
    if (this.text.length > this.max) {
      this.text = this.text.slice(this.text.length - this.max);
      this.truncated = true;
    }
  }
  value(): string {
    return this.text;
  }
}

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
/** OSC (`ESC ] … BEL|ESC \`), CSI (`ESC [ … final`) and two-character ESC sequences. */
const ESCAPES = new RegExp(`${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)|${ESC}\\[[0-9;?]*[ -/]*[@-~]|${ESC}[@-_]`, "g");

/** Plain text of terminal output: escapes removed, CR/LF normalized. */
export function plainTerminalText(text: string): string {
  return text.replace(ESCAPES, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/** Redacted tail of at most `maxChars` characters (a margin keeps a secret cut at the edge redacted). */
function redactedTail(text: string, maxChars: number): string {
  const window = text.length > maxChars + 512 ? text.slice(text.length - maxChars - 512) : text;
  const redacted = redactSecrets(window);
  return redacted.length > maxChars ? redacted.slice(redacted.length - maxChars) : redacted;
}

interface Running {
  child: ChildProcess;
  exited: Promise<{ code: number | null; signal: string | null }>;
  /** The mission that launched it: `stopAll(missionId)` also ends its foreground runs. */
  missionId: string;
}

interface Tracked {
  record: MissionProcess;
  ring: OutputRing;
  /** Raw argv (the record's is redacted for display). */
  argv: string[];
  stopRequested: boolean;
  ended: Promise<void>;
  markEnded(exit: AgentProcessExit): void;
  /** Kills the tree; resolves once the end was recorded. */
  kill(): Promise<void>;
}

interface Mirror {
  sessionId: string | null;
  opening: Promise<void> | null;
  /** Output waiting for the session (opening) or for the next flush. */
  queue: string;
  timer: ReturnType<typeof setTimeout> | null;
  writing: Promise<void>;
  lastExitCode: number | null;
  /** Commands waiting to learn the session id (tool.terminal). */
  waiting: ((sessionId: string) => void)[];
}

const ISOLATION: IsolationLevel = "L0";
/** Quiet time after the first output of a background process before startBackground returns. */
const BACKGROUND_QUIET_MS = 150;
/** Ended processes kept listed (with their output ring) before the oldest are forgotten. */
const MAX_ENDED_PROCESSES = 20;
/** Mirror writes are coalesced for this long (one worker message per burst, not per chunk). */
const MIRROR_FLUSH_MS = 25;
/** Mirror output waiting for a slow host beyond this is dropped (oldest first). */
const MIRROR_QUEUE_MAX_CHARS = 256_000;
/** Longest wait for a pty-hosted process to report its end after its tree was killed. */
const HOST_EXIT_WAIT_MS = 5_000;

/** The main-process runner: its owner also stops every process it started when the app quits. */
export interface ProcessCommandRunner extends CommandRunner {
  /**
   * `onTerminal`: the agent session mirroring this run (called at most once, possibly after the
   * first output). Needs the J2-B `CommandRunner.run` contract change to reach the executors.
   */
  run(spec: CommandSpec, signal: AbortSignal, onOutput?: CommandOutputListener, onTerminal?: (sessionId: string) => void): Promise<CommandOutcome>;
  /**
   * Kills every process tree still running (background AND in-flight foreground runs, all
   * missions) and refuses new launches. Detached POSIX groups get no SIGHUP when NOVA exits, so
   * without this a dev server started by a mission outlives the app.
   */
  stopEverything(): Promise<void>;
  /** Background processes (running and recently ended), oldest first; null filters = all. */
  processes(filter: { workspaceId: string | null; missionId: string | null }): MissionProcess[];
  process(processId: string): MissionProcess | null;
  /** Redacted plain-text tail (≤ maxChars, capped at PROCESS_LIMITS.outputTailMaxChars); null = unknown id. */
  output(processId: string, maxChars: number): ProcessOutput | null;
  onProcessEvent(listener: (event: ProcessEvent) => void): () => void;
  /**
   * « Prendre la main »: the user took over the agent session of a running background process. It
   * leaves the mission (state `handed_over`): no longer counted, listed as running, read, stopped
   * by `stopAll(missionId)` or fed with output; only `stopEverything` (quit) still ends it.
   * Returns its record, or null when no running process has that session.
   */
  handOver(sessionId: string): MissionProcess | null;
}

function commandLine(argv: readonly string[]): string {
  return argv.map((arg) => (arg === "" || /[\s"']/.test(arg) ? JSON.stringify(arg) : arg)).join(" ");
}

function seconds(ms: number): string {
  return (ms / 1000).toFixed(1).replace(".", ",");
}

export function createProcessCommandRunner(options: ProcessCommandRunnerOptions): ProcessCommandRunner {
  const platform = options.platform ?? process.platform;
  const maxOutput = options.maxOutputBytes ?? TOOL_LIMITS.commandOutputMaxBytes;
  const killGraceMs = options.killGraceMs ?? 2_000;
  const settleMs = options.backgroundSettleMs ?? 5_000;
  const now = options.now ?? Date.now;
  const host = options.terminal ?? null;
  const tracked = new Map<string, Tracked>();
  const mirrors = new Map<string, Mirror>();
  const listeners = new Set<(event: ProcessEvent) => void>();
  /** Every live child (foreground and background), for stopEverything. */
  const live = new Set<Running>();
  /**
   * Background starts past the cap check but not tracked yet, per mission. Counted by
   * `runningCount`: concurrent calls (a « Chaîne » program's Promise.all) would otherwise all pass
   * the check before the first one is tracked.
   */
  const starting = new Map<string, number>();
  let stopped = false;

  const snapshot = (entry: Tracked): MissionProcess => ({ ...entry.record, argv: [...entry.record.argv] });
  const emit = (event: ProcessEvent): void => {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        // A listener's failure never breaks the process bookkeeping.
      }
    }
  };
  const reportTerminalError = (error: unknown): void => options.onTerminalError?.(error);

  function pruneEnded(): void {
    const ended = [...tracked.values()].filter((entry) => entry.record.state !== "running");
    for (const entry of ended.slice(0, Math.max(0, ended.length - MAX_ENDED_PROCESSES))) tracked.delete(entry.record.id);
  }

  function track(spec: CommandSpec): Tracked {
    let resolveEnded: () => void = () => undefined;
    const entry: Tracked = {
      record: {
        id: randomUUID(),
        missionId: spec.missionId,
        workspaceId: spec.workspaceId,
        argv: spec.argv.map((arg) => redactSecrets(arg)),
        cwd: spec.cwd,
        pid: null,
        state: "running",
        exitCode: null,
        signal: null,
        startedAt: now(),
        endedAt: null,
        terminalSessionId: null,
        outputChars: 0,
      },
      ring: new OutputRing(PROCESS_LIMITS.outputRingChars),
      argv: [...spec.argv],
      stopRequested: false,
      ended: new Promise<void>((resolve) => {
        resolveEnded = resolve;
      }),
      markEnded(exit) {
        if (entry.record.state !== "running") {
          // A handed-over session's real end is the user's: `ended` only lets waiters go.
          resolveEnded();
          return;
        }
        entry.record.state = entry.stopRequested ? "stopped" : "exited";
        entry.record.exitCode = exit.exitCode;
        entry.record.signal = exit.signal;
        entry.record.endedAt = now();
        resolveEnded();
        // Only emitted for processes the caller saw start (a failed start is never reported).
        if (tracked.get(entry.record.id) === entry) emit({ type: "process.ended", process: snapshot(entry) });
        pruneEnded();
      },
      kill: () => Promise.resolve(),
    };
    return entry;
  }

  function pushOutput(entry: Tracked, chunk: string): void {
    // Taken over: what the user types and the program echoes is theirs, never the mission's.
    if (entry.record.state === "handed_over") return;
    entry.ring.push(chunk);
    entry.record.outputChars = entry.ring.total;
  }

  function runningCount(missionId: string): number {
    let count = starting.get(missionId) ?? 0;
    for (const entry of tracked.values()) if (entry.record.missionId === missionId && entry.record.state === "running") count += 1;
    return count;
  }

  async function launch(spec: CommandSpec): Promise<Running> {
    if (stopped) throw new ToolFailure("cancelled", "NOVA is shutting down");
    const [program, ...args] = spec.argv;
    if (!program) throw new ToolFailure("invalid_arguments", "argv is empty");
    const cwd = await options.resolveCwd(spec.workspaceId, spec.cwd);
    if (cwd === null) throw new ToolFailure("outside_workspace", `cwd "${spec.cwd}" is outside the workspace`);
    const source = options.env ?? process.env;
    const env = scrubCommandEnv(source, { CI: "1", NO_COLOR: "1", ...spec.env });
    const target = platform === "win32" ? await windowsInvocation([program, ...args], cwd, source) : { file: program, args, verbatim: false };
    const child = spawn(target.file, target.args, {
      cwd,
      env,
      shell: false,
      windowsVerbatimArguments: target.verbatim,
      // Own process group on POSIX so the whole tree can be signalled at once.
      detached: platform !== "win32",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const exited = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
      child.once("error", (error: NodeJS.ErrnoException) => {
        reject(
          error.code === "ENOENT"
            ? new ToolFailure("not_found", `program "${program}" was not found on PATH`)
            : new ToolFailure("failed", `could not start "${program}" (${error.code ?? "unknown error"})`),
        );
      });
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    // Surface spawn failures (ENOENT) before any output handling.
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", () => resolve());
      exited.catch(reject);
    });
    const running = { child, exited, missionId: spec.missionId };
    live.add(running);
    void exited.catch(() => undefined).finally(() => live.delete(running));
    // Launched while stopEverything was already running: it would not see this child.
    if (stopped) void killTree(running);
    return running;
  }

  async function killTree(running: Running): Promise<void> {
    const pid = running.child.pid;
    if (pid === undefined || running.child.exitCode !== null || running.child.signalCode !== null) {
      await running.exited.catch(() => undefined);
      return;
    }
    const send = (signal: NodeJS.Signals): void => {
      try {
        if (platform === "win32") {
          spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        } else {
          process.kill(-pid, signal);
        }
      } catch {
        // Already gone.
      }
    };
    send("SIGTERM");
    const timer = setTimeout(() => send("SIGKILL"), killGraceMs);
    await running.exited.catch(() => undefined);
    clearTimeout(timer);
    // Descendants that ignored SIGTERM and outlived the leader.
    if (platform !== "win32") send("SIGKILL");
  }

  function attachOutput(running: Running, listener: (stream: "stdout" | "stderr", text: string, bytes: number) => void): void {
    const decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() };
    for (const stream of ["stdout", "stderr"] as const) {
      running.child[stream]?.on("data", (chunk: Buffer) => listener(stream, decoders[stream].decode(chunk, { stream: true }), chunk.byteLength));
    }
  }

  // -------------------------------------------------------------------------
  // Mirror of foreground runs (one agent session per mission)

  function flushMirror(mirror: Mirror): void {
    if (mirror.timer) clearTimeout(mirror.timer);
    mirror.timer = null;
    const sessionId = mirror.sessionId;
    if (!host || sessionId === null || mirror.queue === "") return;
    const data = redactSecrets(mirror.queue);
    mirror.queue = "";
    mirror.writing = mirror.writing
      .then(() => host.writeMirror(sessionId, data))
      .then(
        (ok) => {
          if (!ok && mirror.sessionId === sessionId) mirror.sessionId = null;
        },
        (error: unknown) => {
          if (mirror.sessionId === sessionId) mirror.sessionId = null;
          reportTerminalError(error);
        },
      );
  }

  function writeMirror(mirror: Mirror, text: string): void {
    mirror.queue += text;
    if (mirror.queue.length > MIRROR_QUEUE_MAX_CHARS) mirror.queue = mirror.queue.slice(mirror.queue.length - MIRROR_QUEUE_MAX_CHARS);
    if (mirror.sessionId !== null) mirror.timer ??= setTimeout(() => flushMirror(mirror), MIRROR_FLUSH_MS);
  }

  /** The mission's mirror, (re)opened when needed; null without a terminal host. */
  function mirrorFor(spec: CommandSpec, onTerminal?: (sessionId: string) => void): Mirror | null {
    if (!host) return null;
    let mirror = mirrors.get(spec.missionId);
    if (!mirror) {
      mirror = { sessionId: null, opening: null, queue: "", timer: null, writing: Promise.resolve(), lastExitCode: null, waiting: [] };
      mirrors.set(spec.missionId, mirror);
    }
    const current = mirror;
    if (current.sessionId !== null) {
      onTerminal?.(current.sessionId);
      return current;
    }
    if (onTerminal) current.waiting.push(onTerminal);
    current.opening ??= host
      .openMirror({ workspaceId: spec.workspaceId, missionId: spec.missionId, cwd: spec.cwd })
      .then(
        (sessionId) => {
          current.sessionId = sessionId;
          if (sessionId === null) current.queue = "";
        },
        (error: unknown) => {
          current.queue = "";
          reportTerminalError(error);
        },
      )
      .finally(() => {
        current.opening = null;
        const waiting = current.waiting.splice(0);
        const sessionId = current.sessionId;
        if (sessionId === null || mirrors.get(spec.missionId) !== current) return;
        for (const notify of waiting) notify(sessionId);
        flushMirror(current);
      });
    return current;
  }

  async function closeMirror(missionId: string): Promise<void> {
    const mirror = mirrors.get(missionId);
    if (!mirror || !host) return;
    mirrors.delete(missionId);
    await mirror.opening;
    flushMirror(mirror);
    await mirror.writing;
    if (mirror.sessionId !== null) await host.closeMirror(mirror.sessionId, mirror.lastExitCode).catch(reportTerminalError);
  }

  // -------------------------------------------------------------------------
  // Background processes

  /** Runs the process in an agent terminal session; null = no terminal here. */
  async function startHosted(
    terminal: AgentTerminalHost,
    spec: CommandSpec,
    entry: Tracked,
    onChunk: (chunk: string) => void,
  ): Promise<boolean> {
    const [program, ...args] = spec.argv;
    if (!program) throw new ToolFailure("invalid_arguments", "argv is empty");
    const cwd = await options.resolveCwd(spec.workspaceId, spec.cwd);
    if (cwd === null) throw new ToolFailure("outside_workspace", `cwd "${spec.cwd}" is outside the workspace`);
    const source = options.env ?? process.env;
    const env = checkedExtraEnv({ CI: "1", ...spec.env });
    let resolved: AgentProgram;
    if (platform === "win32") {
      resolved = await windowsInvocation([program, ...args], cwd, source);
    } else {
      const file = await resolvePosixProgram(program, cwd, source);
      if (file === null) throw new ToolFailure("not_found", `program "${program}" was not found on PATH`);
      resolved = { file, args, verbatim: false };
    }
    const started = await terminal.startProcess(
      {
        workspaceId: spec.workspaceId,
        missionId: spec.missionId,
        cwd: spec.cwd,
        program: resolved,
        env,
        title: commandLine(entry.record.argv).slice(0, 200),
      },
      { onData: onChunk, onExit: (exit) => entry.markEnded(exit) },
    );
    if (started === null) return false;
    entry.record.pid = started.pid;
    entry.record.terminalSessionId = started.sessionId;
    entry.kill = async () => {
      await terminal.stopProcess(started.sessionId).catch(reportTerminalError);
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([entry.ended, new Promise((resolve) => (timer = setTimeout(resolve, HOST_EXIT_WAIT_MS)))]);
      clearTimeout(timer);
      // The host never reported the end: it stays unknown (no exit code), not "still running".
      entry.markEnded({ exitCode: null, signal: null });
    };
    return true;
  }

  async function startChild(spec: CommandSpec, entry: Tracked, onChunk: (chunk: string) => void): Promise<void> {
    const running = await launch(spec);
    attachOutput(running, (_stream, text) => onChunk(text));
    entry.record.pid = running.child.pid ?? null;
    void running.exited.then(
      ({ code, signal }) => entry.markEnded({ exitCode: code, signal }),
      () => entry.markEnded({ exitCode: null, signal: null }),
    );
    entry.kill = async () => {
      await killTree(running);
      await entry.ended;
    };
  }

  async function stopTracked(entry: Tracked): Promise<void> {
    if (entry.record.state !== "running") return;
    entry.stopRequested = true;
    await entry.kill();
  }

  return {
    async run(spec, signal, onOutput, onTerminal) {
      if (signal.aborted) throw new ToolFailure("cancelled", "stopped before start");
      const started = Date.now();
      const mirror = stopped ? null : mirrorFor(spec, onTerminal);
      let running: Running;
      try {
        running = await launch(spec);
      } catch (error) {
        if (mirror && error instanceof ToolFailure) writeMirror(mirror, `\x1b[2m$ ${commandLine(spec.argv)}\x1b[0m\r\n[${error.message}]\r\n`);
        throw error;
      }
      if (mirror) writeMirror(mirror, `\x1b[2m$ ${commandLine(spec.argv)}\x1b[0m\r\n`);
      const output = new OutputTail(maxOutput);
      attachOutput(running, (stream, text, bytes) => {
        output.push(text, bytes);
        onOutput?.(stream, text);
        // No pty line discipline here: a bare LF would not return the terminal cursor.
        if (mirror) writeMirror(mirror, text.replace(/\r?\n/g, "\r\n"));
      });
      let timedOut = false;
      let cancelled = false;
      const timeoutMs = Math.min(Math.max(1, spec.timeoutMs), TOOL_LIMITS.commandTimeoutMaxMs);
      const timer = setTimeout(() => {
        timedOut = true;
        void killTree(running);
      }, timeoutMs);
      const onAbort = (): void => {
        cancelled = true;
        void killTree(running);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        const { code, signal: exitSignal } = await running.exited;
        const durationMs = Date.now() - started;
        if (mirror) {
          mirror.lastExitCode = code;
          const status = timedOut ? "délai dépassé" : cancelled ? "arrêtée" : `code ${code === null ? "inconnu" : String(code)}`;
          writeMirror(mirror, `\x1b[2m[${status}${exitSignal ? ` · ${exitSignal}` : ""} · ${seconds(durationMs)} s]\x1b[0m\r\n\r\n`);
        }
        return {
          exitCode: code,
          signal: exitSignal,
          durationMs,
          output: output.value(),
          outputBytes: output.bytes,
          truncated: output.truncated,
          timedOut,
          cancelled,
          isolationLevel: ISOLATION,
        } satisfies CommandOutcome;
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
      }
    },

    async startBackground(spec, onOutput) {
      if (stopped) throw new ToolFailure("cancelled", "NOVA is shutting down");
      if (runningCount(spec.missionId) >= PROCESS_LIMITS.maxRunningPerMission) {
        throw new ToolFailure(
          "too_large",
          `this mission already runs ${PROCESS_LIMITS.maxRunningPerMission} background processes: stop one before starting another`,
        );
      }
      // The slot is held from the check until the process is tracked (or its start failed).
      starting.set(spec.missionId, (starting.get(spec.missionId) ?? 0) + 1);
      const releaseSlot = (): void => {
        const left = (starting.get(spec.missionId) ?? 1) - 1;
        if (left > 0) starting.set(spec.missionId, left);
        else starting.delete(spec.missionId);
      };
      let initial = "";
      let settled = false;
      // Returns once the process printed something and paused briefly, exited, or `settleMs` passed.
      let firstOutput: () => void = () => undefined;
      const printed = new Promise<void>((resolve) => {
        firstOutput = resolve;
      }).then(() => new Promise((resolve) => setTimeout(resolve, BACKGROUND_QUIET_MS)));
      const entry = track(spec);
      const onChunk = (chunk: string): void => {
        pushOutput(entry, chunk);
        firstOutput();
        // Live output belongs to the call only until it returns; later output stays in the ring
        // (process_output) and the agent terminal.
        if (settled) return;
        initial += chunk;
        onOutput?.("stdout", chunk);
      };
      try {
        const hosted = host ? await startHosted(host, spec, entry, onChunk) : false;
        if (!hosted) await startChild(spec, entry, onChunk);
        tracked.set(entry.record.id, entry);
      } finally {
        releaseSlot();
      }
      emit({ type: "process.started", process: snapshot(entry) });
      // Ended before being tracked (instant exit): report its end now that its start was reported.
      if (entry.record.state !== "running") emit({ type: "process.ended", process: snapshot(entry) });
      let settleTimer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        entry.ended,
        printed,
        new Promise((resolve) => {
          settleTimer = setTimeout(resolve, settleMs);
        }),
      ]);
      clearTimeout(settleTimer);
      settled = true;
      const info: BackgroundProcess = {
        id: entry.record.id,
        missionId: entry.record.missionId,
        argv: [...entry.argv],
        cwd: entry.record.cwd,
        pid: entry.record.pid,
        startedAt: entry.record.startedAt,
        state: entry.record.state === "running" ? "running" : "exited",
        exitCode: entry.record.exitCode,
      };
      const shown = entry.record.terminalSessionId ? plainTerminalText(initial) : initial;
      return { process: info, initialOutput: shown.slice(-8_000), isolationLevel: ISOLATION };
    },

    list(missionId) {
      return [...tracked.values()]
        .filter((entry) => entry.record.missionId === missionId && (entry.record.state === "running" || entry.record.state === "exited"))
        .map((entry) => ({
          id: entry.record.id,
          missionId: entry.record.missionId,
          argv: [...entry.argv],
          cwd: entry.record.cwd,
          pid: entry.record.pid,
          startedAt: entry.record.startedAt,
          state: entry.record.state === "running" ? ("running" as const) : ("exited" as const),
          exitCode: entry.record.exitCode,
        }));
    },

    async stop(processId) {
      const entry = tracked.get(processId);
      if (entry) await stopTracked(entry);
    },

    async stopAll(missionId) {
      // A handed-over session is the user's: stopTracked leaves it (only stopEverything ends it).
      const entries = [...tracked.values()].filter((entry) => entry.record.missionId === missionId);
      const foreground = [...live].filter((running) => running.missionId === missionId);
      await Promise.all([...entries.map((entry) => stopTracked(entry)), ...foreground.map((running) => killTree(running))]);
      await closeMirror(missionId);
    },

    async stopEverything() {
      stopped = true;
      await Promise.all([
        ...[...live].map((running) => killTree(running)),
        ...[...tracked.values()].map((entry) => (entry.record.state === "handed_over" ? entry.kill() : stopTracked(entry))),
        ...[...mirrors.keys()].map((missionId) => closeMirror(missionId)),
      ]);
    },

    handOver(sessionId) {
      const entry = [...tracked.values()].find((item) => item.record.terminalSessionId === sessionId && item.record.state === "running");
      if (!entry) return null;
      entry.record.state = "handed_over";
      entry.record.endedAt = now();
      entry.markEnded({ exitCode: null, signal: null });
      // The mission's view of it ends here: journaled (process.ended) so the mission is told.
      emit({ type: "process.ended", process: snapshot(entry) });
      pruneEnded();
      return snapshot(entry);
    },

    processes(filter) {
      return [...tracked.values()]
        .filter((entry) => (filter.workspaceId === null || entry.record.workspaceId === filter.workspaceId) && (filter.missionId === null || entry.record.missionId === filter.missionId))
        .sort((a, b) => a.record.startedAt - b.record.startedAt)
        .map(snapshot);
    },

    process(processId) {
      const entry = tracked.get(processId);
      return entry ? snapshot(entry) : null;
    },

    output(processId, maxChars) {
      const entry = tracked.get(processId);
      if (!entry) return null;
      const limit = Math.max(1, Math.min(maxChars, PROCESS_LIMITS.outputTailMaxChars));
      const plain = plainTerminalText(entry.ring.value());
      return {
        processId,
        state: entry.record.state,
        text: redactedTail(plain, limit),
        truncated: entry.ring.dropped || plain.length > limit,
        totalChars: entry.ring.total,
      };
    },

    onProcessEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
