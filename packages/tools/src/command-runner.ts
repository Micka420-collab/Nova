// L0 process execution for run_command / run_tests (A3, S3): argv without a shell, cwd resolved
// and contained by the injected resolver, scrubbed environment, timeout, bounded output kept in
// memory (tail), and the whole process tree killed on stop/timeout (POSIX process group, Windows
// `taskkill /T`). Host-agnostic: main or the pty-host instantiates it.
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { TOOL_LIMITS, type IsolationLevel } from "@nova/shared";
import type { BackgroundProcess, CommandOutcome, CommandOutputListener, CommandRunner, CommandSpec } from "./apis";
import { ToolFailure } from "./content";

const ENV_ALLOWLIST: ReadonlySet<string> = new Set([
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LANGUAGE", "TERM", "TMPDIR", "TMP", "TEMP", "TZ",
  "Path", "PATHEXT", "SystemRoot", "SystemDrive", "windir", "ComSpec", "USERPROFILE", "USERNAME",
  "APPDATA", "LOCALAPPDATA", "ProgramData", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432",
  "CommonProgramFiles", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "OS",
]);
const ENV_PREFIX_ALLOWLIST = ["LC_"];
const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|COOKIE|SESSION)/i;

/** Allowlisted, credential-free environment for project commands (no NOVA_*, ELECTRON_*, NODE_OPTIONS). */
export function scrubCommandEnv(
  env: Readonly<Record<string, string | undefined>>,
  extra: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    const allowed = ENV_ALLOWLIST.has(name) || ENV_PREFIX_ALLOWLIST.some((prefix) => name.startsWith(prefix));
    if (allowed && !SECRET_NAME.test(name)) result[name] = value;
  }
  for (const [name, value] of Object.entries(extra)) {
    if (SECRET_NAME.test(name)) throw new ToolFailure("invalid_arguments", `environment variable ${name} is not allowed`);
    result[name] = value;
  }
  return result;
}

export interface ProcessCommandRunnerOptions {
  /** Absolute cwd for a workspace-relative path, or null when it escapes the root (S2). */
  resolveCwd(workspaceId: string, cwd: string): Promise<string | null>;
  /** Environment to scrub (default process.env). */
  env?: Readonly<Record<string, string | undefined>>;
  /** Bytes of output kept in memory per process (default TOOL_LIMITS.commandOutputMaxBytes). */
  maxOutputBytes?: number;
  /** Grace period between SIGTERM and SIGKILL. */
  killGraceMs?: number;
  /** Longest wait of startBackground for a first output (it returns earlier once output arrived). */
  backgroundSettleMs?: number;
  platform?: NodeJS.Platform;
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

interface Running {
  child: ChildProcess;
  exited: Promise<{ code: number | null; signal: string | null }>;
}

const ISOLATION: IsolationLevel = "L0";
/** Quiet time after the first output of a background process before startBackground returns. */
const BACKGROUND_QUIET_MS = 150;

export function createProcessCommandRunner(options: ProcessCommandRunnerOptions): CommandRunner {
  const platform = options.platform ?? process.platform;
  const maxOutput = options.maxOutputBytes ?? TOOL_LIMITS.commandOutputMaxBytes;
  const killGraceMs = options.killGraceMs ?? 2_000;
  const settleMs = options.backgroundSettleMs ?? 5_000;
  const background = new Map<string, { info: BackgroundProcess; running: Running }>();

  async function launch(spec: CommandSpec): Promise<Running> {
    const [program, ...args] = spec.argv;
    if (!program) throw new ToolFailure("invalid_arguments", "argv is empty");
    const cwd = await options.resolveCwd(spec.workspaceId, spec.cwd);
    if (cwd === null) throw new ToolFailure("outside_workspace", `cwd "${spec.cwd}" is outside the workspace`);
    const env = scrubCommandEnv(options.env ?? process.env, { CI: "1", NO_COLOR: "1", ...spec.env });
    const child = spawn(program, args, {
      cwd,
      env,
      shell: false,
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
            : new ToolFailure("failed", `could not start "${program}"`),
        );
      });
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    // Surface spawn failures (ENOENT) before any output handling.
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", () => resolve());
      exited.catch(reject);
    });
    return { child, exited };
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

  function attachOutput(running: Running, tailBuffer: OutputTail, listener?: CommandOutputListener): void {
    const decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() };
    for (const stream of ["stdout", "stderr"] as const) {
      running.child[stream]?.on("data", (chunk: Buffer) => {
        const text = decoders[stream].decode(chunk, { stream: true });
        tailBuffer.push(text, chunk.byteLength);
        listener?.(stream, text);
      });
    }
  }

  return {
    async run(spec, signal, onOutput) {
      if (signal.aborted) throw new ToolFailure("cancelled", "stopped before start");
      const started = Date.now();
      const running = await launch(spec);
      const output = new OutputTail(maxOutput);
      attachOutput(running, output, onOutput);
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
        return {
          exitCode: code,
          signal: exitSignal,
          durationMs: Date.now() - started,
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
      const running = await launch(spec);
      const output = new OutputTail(maxOutput);
      let initial = "";
      let settled = false;
      // Returns once the process printed something and paused briefly, exited, or `settleMs` passed.
      let firstOutput: () => void = () => undefined;
      const printed = new Promise<void>((resolve) => {
        firstOutput = resolve;
      }).then(() => new Promise((resolve) => setTimeout(resolve, BACKGROUND_QUIET_MS)));
      attachOutput(running, output, (stream, chunk) => {
        if (!settled) initial += chunk;
        firstOutput();
        onOutput?.(stream, chunk);
      });
      const info: BackgroundProcess = {
        id: randomUUID(),
        missionId: spec.missionId,
        argv: [...spec.argv],
        cwd: spec.cwd,
        pid: running.child.pid ?? null,
        startedAt: Date.now(),
        state: "running",
        exitCode: null,
      };
      background.set(info.id, { info, running });
      void running.exited.then(
        ({ code }) => {
          info.state = "exited";
          info.exitCode = code;
        },
        () => {
          info.state = "exited";
        },
      );
      let settleTimer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        running.exited.catch(() => undefined),
        printed,
        new Promise((resolve) => {
          settleTimer = setTimeout(resolve, settleMs);
        }),
      ]);
      clearTimeout(settleTimer);
      settled = true;
      return { process: { ...info }, initialOutput: initial.slice(-8_000), isolationLevel: ISOLATION };
    },

    list(missionId) {
      return [...background.values()].filter((entry) => entry.info.missionId === missionId).map((entry) => ({ ...entry.info }));
    },

    async stop(processId) {
      const entry = background.get(processId);
      if (!entry) return;
      await killTree(entry.running);
      background.delete(processId);
    },

    async stopAll(missionId) {
      const ids = [...background.values()].filter((entry) => entry.info.missionId === missionId).map((entry) => entry.info.id);
      await Promise.all(ids.map((id) => this.stop(id)));
    },
  };
}
