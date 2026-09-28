// ChainService (L4): `ToolDeps.chain` for every workspace. Each program gets its OWN chain-host
// utilityProcess, started for it and killed right after (success, error, timeout, stop, limit):
// nothing a program does survives it, and a runaway program costs one process, never main.
// The host gets the scrubbed worker environment (no secret), a V8 heap cap, and no stdin; its
// stdout/stderr are diagnostics only (logged capped and redacted, never shown to the model).
import { utilityProcess, type UtilityProcess } from "electron";
import {
  createChainRunner,
  type ChainHostConnection,
  type ChainHostExit,
  type ChainLimits,
  type ChainNestedRunContext,
  type ChainRunOutcome,
  type ChainRunner,
} from "@nova/chain";
import { CHAIN_LIMITS, redactSecrets } from "@nova/shared";
import type { Logger } from "../logger";
import { scrubEnv } from "../workers";

type Forker = (entry: string, args: string[], options: Electron.ForkOptions) => UtilityProcess;

export interface ChainServiceDeps {
  /** Built host entry: out/main/workers/chain-host.js. */
  entry: string;
  logger: Logger;
  /** Process environment to scrub (default: process.env). */
  env?: Readonly<Record<string, string | undefined>>;
  /** Injected for tests; default `utilityProcess.fork`. */
  fork?: Forker;
  /** A host that is not listening after this delay is killed (the run fails visibly). */
  startTimeoutMs?: number;
  limits?: Partial<ChainLimits>;
}

export interface ChainService extends ChainRunner {
  /** Diagnostics: runs `return 6 * 7` in a real host; `ok` only when it answered 42. */
  selfTest(): Promise<{ ok: boolean; detail: string }>;
  /** Kills every running host (app quit). Resolves once they exited. */
  stopAll(): Promise<void>;
  /** Hosts currently alive (tests, exit warning). */
  readonly running: number;
}

const START_TIMEOUT_MS = 10_000;
const DIAGNOSTIC_MAX = 2_000;
/** What V8 prints on stderr when a heap cap is hit ("Last few GCs" … "JavaScript heap out of memory"). */
const OUT_OF_MEMORY = /heap out of memory|Last few GCs/;

export function createChainService(deps: ChainServiceDeps): ChainService {
  const limits: ChainLimits = { ...CHAIN_LIMITS, ...deps.limits };
  const fork: Forker = deps.fork ?? ((entry, args, options) => utilityProcess.fork(entry, args, options));
  const alive = new Map<UtilityProcess, Promise<void>>();

  const openHost = (): ChainHostConnection => {
    const child = fork(deps.entry, [], {
      serviceName: "NOVA chain-host",
      env: scrubEnv(deps.env ?? process.env),
      stdio: ["ignore", "pipe", "pipe"],
      // Hard stop for an allocation spree inside one slice (the host reports `limit` at
      // CHAIN_LIMITS.heapMb between slices). A utilityProcess applies V8 flags only through
      // --js-flags: a bare --max-old-space-size is accepted and ignored (checked on Electron 44).
      execArgv: [`--js-flags=--max-old-space-size=${limits.heapMb * 2}`],
    });
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    alive.set(child, exited);

    let ready = false;
    let gone = false;
    const queue: unknown[] = [];
    const messageListeners: ((message: unknown) => void)[] = [];
    const exitListeners: ((exit: ChainHostExit) => void)[] = [];

    // The program cannot write to these (it has no console of the host): only the host and V8 do.
    let outOfMemory = false;
    const log = (stream: string) => (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      if (OUT_OF_MEMORY.test(text)) outOfMemory = true;
      deps.logger.warn("chain-host output", { stream, text: redactSecrets(text.slice(0, DIAGNOSTIC_MAX)) });
    };
    child.stdout?.on("data", log("stdout"));
    child.stderr?.on("data", log("stderr"));

    const kill = (): void => {
      if (gone) return;
      gone = true;
      child.kill();
    };
    const startTimer = setTimeout(() => {
      if (!ready) {
        deps.logger.error("chain-host start timed out", {});
        kill();
      }
    }, deps.startTimeoutMs ?? START_TIMEOUT_MS);

    child.on("message", (message: unknown) => {
      if (!ready && typeof message === "object" && message !== null && (message as { type?: unknown }).type === "ready") {
        ready = true;
        clearTimeout(startTimer);
        for (const queued of queue.splice(0)) child.postMessage(queued);
        return;
      }
      for (const listener of messageListeners) listener(message);
    });
    child.once("exit", (code: number) => {
      clearTimeout(startTimer);
      gone = true;
      alive.delete(child);
      const exit: ChainHostExit = { code: Number.isInteger(code) ? code : null, outOfMemory };
      for (const listener of exitListeners) listener(exit);
    });

    return {
      send(request) {
        if (gone) return;
        if (ready) child.postMessage(request);
        else queue.push(request);
      },
      onMessage: (listener) => void messageListeners.push(listener),
      onExit: (listener) => void exitListeners.push(listener),
      kill,
    };
  };

  const runner = createChainRunner({ openHost, limits });

  return {
    run: (program: string, context: ChainNestedRunContext): Promise<ChainRunOutcome> => runner.run(program, context),
    async selfTest() {
      const outcome = await runner.run("return 6 * 7;", {
        workspaceId: "selftest",
        missionId: "selftest",
        callId: "selftest",
        signal: AbortSignal.timeout(30_000),
        // `return 6 * 7` calls no tool; anything else would be refused by the runner's failure path.
        runNested: () => Promise.reject(new Error("the self-test calls no tool")),
      });
      const ok = outcome.summary.state === "succeeded" && outcome.result === "42";
      return { ok, detail: ok ? "chain-host ok" : `${outcome.summary.state}: ${outcome.summary.error ?? "unexpected result"}` };
    },
    async stopAll() {
      const pending = [...alive.entries()];
      for (const [child] of pending) child.kill();
      await Promise.all(pending.map(([, exited]) => exited));
    },
    get running() {
      return alive.size;
    },
  };
}
