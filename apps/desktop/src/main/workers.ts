// utilityProcess launcher: one supervised worker per name, request/response over its parent port,
// MessagePort transfer, crash restart with backoff, and a scrubbed environment (no secrets).
//
// Lifecycle: `stopped` → start() → `starting` → (worker posts `ready`) → `running`.
// An unexpected exit rejects the in-flight requests (`unavailable`) and restarts the worker after a
// backoff, at most `maxRestarts` times per `restartWindowMs`; beyond that the worker is `failed`
// until start() is called again. stop() never restarts. Requests made while starting are queued
// until `ready`.
import { utilityProcess, type MessagePortMain, type UtilityProcess } from "electron";
import type { Logger } from "./logger";
import { ServiceError } from "./service-error";
import {
  isWorkerToMain,
  type MainToWorker,
  type WorkerName,
  type WorkerNotify,
  type WorkerPong,
  type WorkerToMain,
} from "../workers/protocol";

export type WorkerState = "stopped" | "starting" | "running" | "restarting" | "failed";

/** Environment variables a worker may inherit (exact names, case-sensitive on POSIX). */
const ENV_ALLOWLIST: ReadonlySet<string> = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LANGUAGE",
  "TERM",
  "COLORTERM",
  "TMPDIR",
  "TMP",
  "TEMP",
  "TZ",
  "DISPLAY",
  "WAYLAND_DISPLAY",
  // Workers run the Electron binary itself: it must find the same shared libraries as main
  // (AppImage and non-standard installs set this; without it the worker exits with code 127).
  "LD_LIBRARY_PATH",
  // Windows
  "Path",
  "PATHEXT",
  "SystemRoot",
  "SystemDrive",
  "windir",
  "ComSpec",
  "USERPROFILE",
  "USERNAME",
  "APPDATA",
  "LOCALAPPDATA",
  "ProgramData",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "ProgramW6432",
  "CommonProgramFiles",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "OS",
]);

const ENV_PREFIX_ALLOWLIST = ["LC_", "XDG_"];

/** Even an allowlisted-looking name is dropped if it smells like a credential. */
const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|COOKIE|SESSION)/i;

/**
 * Minimal environment for a worker: allowlisted names only, never credentials, never NOVA_*,
 * ELECTRON_* or NODE_OPTIONS (they change runtime behavior). `extra` is added last (values chosen
 * by main, e.g. NOVA_RG_PATH) and must not contain secrets either.
 */
export function scrubEnv(
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
    if (SECRET_NAME.test(name)) throw new Error(`Refusing to pass ${name} to a worker`);
    result[name] = value;
  }
  return result;
}

export interface WorkerSpec {
  name: WorkerName;
  /** Absolute path of the built worker entry (out/main/workers/<name>.js). */
  entry: string;
  /** Non-secret variables added to the scrubbed environment. */
  env?: Readonly<Record<string, string>>;
  cwd?: string;
  maxRestarts?: number;
  restartWindowMs?: number;
  /** Delay before a restart, doubled for each restart within the window. */
  restartDelayMs?: number;
  requestTimeoutMs?: number;
  startTimeoutMs?: number;
}

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type Forker = (entry: string, args: string[], options: Electron.ForkOptions) => UtilityProcess;

export interface WorkerDeps {
  logger: Logger;
  /** Process environment to scrub (default: process.env). */
  env?: Readonly<Record<string, string | undefined>>;
  /** Injected for tests; default `utilityProcess.fork`. */
  fork?: Forker;
}

const DEFAULTS = {
  maxRestarts: 3,
  restartWindowMs: 60_000,
  restartDelayMs: 500,
  requestTimeoutMs: 30_000,
  startTimeoutMs: 10_000,
} as const;

function unavailable(name: WorkerName, why: string): ServiceError {
  return new ServiceError("unavailable", `${name} ${why}`);
}

export class ManagedWorker {
  private child: UtilityProcess | null = null;
  private stateValue: WorkerState = "stopped";
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly queue: { message: MainToWorker; transfer: MessagePortMain[] }[] = [];
  private restarts: number[] = [];
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private startTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly listeners = new Set<(event: WorkerNotify) => void>();
  private readonly options: Required<Omit<WorkerSpec, "env" | "cwd">> & Pick<WorkerSpec, "env" | "cwd">;

  constructor(
    spec: WorkerSpec,
    private readonly deps: WorkerDeps,
  ) {
    this.options = { ...DEFAULTS, ...spec };
  }

  get name(): WorkerName {
    return this.options.name;
  }

  get state(): WorkerState {
    return this.stateValue;
  }

  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  /** Starts the worker if it is not running; idempotent. */
  start(): void {
    if (this.stateValue === "starting" || this.stateValue === "running") return;
    if (this.stateValue === "failed" || this.stateValue === "stopped") this.restarts = [];
    this.spawn();
  }

  /** Stops the worker for good (no restart) and rejects everything in flight. */
  stop(): void {
    this.clearTimers();
    this.stateValue = "stopped";
    const child = this.child;
    this.child = null;
    this.failAll(unavailable(this.name, "stopped"));
    child?.kill();
  }

  /** Worker events (`notify` messages). Returns an unsubscribe function. */
  onNotify(listener: (event: WorkerNotify) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Calls `method` in the worker; rejects with ServiceError(`unavailable`) if it dies or times out. */
  request<T = unknown>(method: string, params: unknown = null, transfer: MessagePortMain[] = []): Promise<T> {
    if (this.stateValue === "stopped" || this.stateValue === "failed") {
      return Promise.reject(unavailable(this.name, `is ${this.stateValue}`));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(unavailable(this.name, `did not answer ${method}`));
      }, this.options.requestTimeoutMs);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      this.send({ kind: "request", id, method, params }, transfer);
    });
  }

  /** Fire-and-forget message (e.g. handing over a MessagePort). */
  notify(method: string, params: unknown = null, transfer: MessagePortMain[] = []): void {
    this.send({ kind: "notify", method, params }, transfer);
  }

  ping(): Promise<WorkerPong> {
    return this.request<WorkerPong>("ping");
  }

  private send(message: MainToWorker, transfer: MessagePortMain[]): void {
    if (this.stateValue === "running" && this.child) this.child.postMessage(message, transfer);
    else this.queue.push({ message, transfer });
  }

  private spawn(): void {
    const { logger } = this.deps;
    const fork = this.deps.fork ?? ((entry, args, options) => utilityProcess.fork(entry, args, options));
    this.stateValue = "starting";
    const child = fork(this.options.entry, [], {
      serviceName: `NOVA ${this.name}`,
      env: scrubEnv(this.deps.env ?? process.env, this.options.env),
      stdio: "pipe",
      ...(this.options.cwd ? { cwd: this.options.cwd } : {}),
    });
    this.child = child;
    // stderr/stdout are diagnostics only: logged with a size cap, never forwarded to the renderer.
    const log = (stream: string) => (chunk: Buffer) =>
      logger.warn("worker output", { worker: this.name, stream, text: chunk.toString("utf8").slice(0, 2_000) });
    child.stdout?.on("data", log("stdout"));
    child.stderr?.on("data", log("stderr"));
    child.on("message", (message: unknown) => this.onMessage(child, message));
    child.on("exit", (code) => this.onExit(child, code));
    this.startTimer = setTimeout(() => {
      if (this.child === child && this.stateValue === "starting") {
        logger.error("worker start timed out", { worker: this.name });
        child.kill();
      }
    }, this.options.startTimeoutMs);
  }

  private onMessage(child: UtilityProcess, message: unknown): void {
    if (child !== this.child || !isWorkerToMain(message)) return;
    this.handle(message);
  }

  private handle(message: WorkerToMain): void {
    if (message.kind === "ready") {
      if (this.startTimer) clearTimeout(this.startTimer);
      this.startTimer = null;
      this.stateValue = "running";
      this.deps.logger.info("worker ready", { worker: this.name, pid: message.pid });
      for (const { message: queued, transfer } of this.queue.splice(0)) this.child?.postMessage(queued, transfer);
      return;
    }
    if (message.kind === "notify") {
      for (const listener of this.listeners) listener(message);
      return;
    }
    const entry = this.pending.get(message.id);
    if (!entry) return;
    this.pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.ok) entry.resolve(message.result);
    else {
      const code = message.error.code === "invalid_params" ? "invalid_request" : "unavailable";
      entry.reject(new ServiceError(code, `${this.name}: ${message.error.message}`));
    }
  }

  private onExit(child: UtilityProcess, code: number): void {
    if (child !== this.child) return;
    this.child = null;
    if (this.startTimer) clearTimeout(this.startTimer);
    this.startTimer = null;
    this.failAll(unavailable(this.name, "exited"));
    if (this.stateValue === "stopped") return;
    const now = Date.now();
    this.restarts = this.restarts.filter((at) => now - at < this.options.restartWindowMs);
    if (this.restarts.length >= this.options.maxRestarts) {
      this.stateValue = "failed";
      this.deps.logger.error("worker failed", { worker: this.name, code, restarts: this.restarts.length });
      return;
    }
    const delay = this.options.restartDelayMs * 2 ** this.restarts.length;
    this.restarts.push(now);
    this.stateValue = "restarting";
    this.deps.logger.warn("worker exited, restarting", { worker: this.name, code, delayMs: delay });
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.stateValue === "restarting") this.spawn();
    }, delay);
  }

  private failAll(error: ServiceError): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
    // Queued messages carry ports: closing them tells the other side the stream is gone.
    for (const { transfer } of this.queue.splice(0)) for (const port of transfer) port.close();
  }

  private clearTimers(): void {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    if (this.startTimer) clearTimeout(this.startTimer);
    this.restartTimer = null;
    this.startTimer = null;
  }
}

/** The app's workers, created lazily by name. */
export class WorkerPool {
  private readonly workers = new Map<WorkerName, ManagedWorker>();

  constructor(
    private readonly specs: Readonly<Record<WorkerName, WorkerSpec>>,
    private readonly deps: WorkerDeps,
  ) {}

  /** Returns the (started) worker. */
  get(name: WorkerName): ManagedWorker {
    let worker = this.workers.get(name);
    if (!worker) {
      worker = new ManagedWorker(this.specs[name], this.deps);
      this.workers.set(name, worker);
    }
    worker.start();
    return worker;
  }

  stopAll(): void {
    for (const worker of this.workers.values()) worker.stop();
  }
}
