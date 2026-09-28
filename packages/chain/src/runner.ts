// ChainRunner (main): runs one program in a fresh chain-host and relays each `nova.<tool>(args)` to
// `runNested`, i.e. back through the SAME ToolGateway as a direct call (parse, mode, permission
// engine, approval, checkpoint, audit), with the run_chain call as parent. The host is never
// trusted: its messages are validated, and every limit it enforces is enforced here again (call
// count, wall time), so a misbehaving host can at worst ask for gated tool calls.
import { randomUUID } from "node:crypto";
import { CHAIN_LIMITS, redactSecrets, type ChainRunState, type ChainRunSummary, type ToolResult } from "@nova/shared";
import { capText, type ChainRunContext } from "@nova/tools";
import { checkChainProgram } from "./program";
import { ChainHostMessageSchema, type ChainHostMessage, type ChainHostRequest } from "./protocol";

export type ChainLimits = { readonly [K in keyof typeof CHAIN_LIMITS]: number };

/** How a host process ended; `code` null = unknown (killed by a signal, or not reported). */
export interface ChainHostExit {
  code: number | null;
  /** The host's V8 reported running out of heap (the hard cap under CHAIN_LIMITS.heapMb × 2). */
  outOfMemory: boolean;
}

/** One started host process (one program). */
export interface ChainHostConnection {
  send(request: ChainHostRequest): void;
  onMessage(listener: (message: unknown) => void): void;
  /** Called once when the process is gone, whoever ended it. */
  onExit(listener: (exit: ChainHostExit) => void): void;
  /** Kills the process tree; idempotent. */
  kill(): void;
}

export interface ChainRunnerDeps {
  /** Starts a fresh, isolated host; throws when it cannot. */
  openHost(): ChainHostConnection;
  now?: () => number;
  limits?: Partial<ChainLimits>;
}

/** What the executor hands the runner (`ChainRunContext` carries the gateway re-entry). */
export type ChainNestedRunContext = ChainRunContext;

export interface ChainRunOutcome {
  summary: ChainRunSummary;
  /** The program's return value as JSON text (bounded, redacted); null when none or on failure. */
  result: string | null;
  /** console.* output of the program (bounded, redacted). */
  logs: string;
}

/**
 * Structurally a `ChainApi` (`ToolDeps.chain`): the executor always passes `runNested` (it is the
 * only caller, see chain-tool.ts); a context without it fails visibly instead of running.
 */
export interface ChainRunner {
  run(program: string, context: ChainNestedRunContext): Promise<ChainRunOutcome>;
}

const ERROR_MAX = 1_000;
const LOG_OMITTED = "\n[… further output omitted …]";

function boundedError(text: string): string {
  const redacted = redactSecrets(text);
  return redacted.length > ERROR_MAX ? `${redacted.slice(0, ERROR_MAX - 1)}…` : redacted;
}

export function createChainRunner(deps: ChainRunnerDeps): ChainRunner {
  const now = deps.now ?? Date.now;
  const limits: ChainLimits = { ...CHAIN_LIMITS, ...deps.limits };

  return {
    async run(program, context) {
      const started = now();
      /** Calls that entered the gateway (what the summary reports). */
      let toolCalls = 0;
      /** Calls the host asked for (what the limit counts). */
      let requested = 0;
      const finished = (state: ChainRunState, error: string | null, result: string | null = null, logs = ""): ChainRunOutcome => ({
        summary: {
          callId: context.callId,
          state,
          toolCalls,
          durationMs: Math.max(0, now() - started),
          error: error === null ? null : boundedError(error),
        },
        result,
        logs,
      });

      if (context.signal.aborted) return finished("cancelled", "stopped by the user");
      if (typeof context.runNested !== "function") return finished("failed", "program calls cannot be relayed in this session");
      const check = checkChainProgram(program, limits.programMaxChars);
      if (!check.ok) return finished("failed", `${check.reason}: ${check.detail}`);

      let connection: ChainHostConnection;
      try {
        connection = deps.openHost();
      } catch {
        return finished("failed", "the program host could not start");
      }

      const runId = randomUUID();
      const inFlight = new Set<Promise<void>>();
      // Aborts the calls still in flight when the program ends on anything but success (timeout,
      // limit, host failure): a pending approval is withdrawn instead of waiting for the user.
      const calls = new AbortController();
      let logs = "";
      let logsFull = false;
      let ended = false;

      return new Promise<ChainRunOutcome>((resolve) => {
        let timer: ReturnType<typeof setTimeout> | null = null;
        const onAbort = (): void => end("cancelled", "stopped by the user");

        const end = (state: ChainRunState, error: string | null, result: string | null = null): void => {
          if (ended) return;
          ended = true;
          if (timer) clearTimeout(timer);
          context.signal.removeEventListener("abort", onAbort);
          connection.kill();
          if (state !== "succeeded") calls.abort();
          const bounded = result === null ? null : capText(redactSecrets(result), limits.resultMaxChars).text;
          // The parent never finishes before its children: calls already relayed settle first (a
          // stop aborts them through the mission signal, a failed end through `calls`; after a
          // success a call still pending waits for its answer, so no approved effect happens after
          // the run_chain card says it ended).
          void Promise.allSettled([...inFlight]).then(() => resolve(finished(state, error, bounded, logs)));
        };

        const relay = async (message: Extract<ChainHostMessage, { type: "tool.call" }>): Promise<void> => {
          // Nothing starts once the program has ended (limit, timeout, stop, host failure).
          if (ended) return;
          toolCalls += 1;
          let result: ToolResult | null = null;
          try {
            result = await context.runNested({ name: message.tool, rawArguments: message.argsJson }, calls.signal);
          } catch {
            result = null;
          }
          if (ended) return;
          connection.send({
            type: "tool.result",
            runId,
            requestId: message.requestId,
            ok: result?.ok ?? false,
            content: result?.content ?? "Error (failed): the tool failed unexpectedly",
          });
        };

        const appendLog = (text: string): void => {
          if (logsFull) return;
          const piece = redactSecrets(text);
          const room = limits.logMaxChars - logs.length;
          if (piece.length + 1 > room) {
            logs += `${logs ? "\n" : ""}${piece.slice(0, Math.max(0, room - 1))}${LOG_OMITTED}`;
            logsFull = true;
            return;
          }
          logs += `${logs ? "\n" : ""}${piece}`;
        };

        connection.onMessage((raw) => {
          if (ended) return;
          const parsed = ChainHostMessageSchema.safeParse(raw);
          if (!parsed.success) return end("failed", "the program host sent an invalid message");
          const message = parsed.data;
          if (message.type === "ready") return;
          if (message.runId !== runId) return;
          switch (message.type) {
            case "tool.call": {
              requested += 1;
              if (requested > limits.maxToolCalls) {
                return end("limit", `the program made more than ${limits.maxToolCalls} tool calls`);
              }
              // Tracked before runNested starts: a stop raised synchronously by the call still waits for it.
              const pending = Promise.resolve().then(() => relay(message));
              inFlight.add(pending);
              void pending.finally(() => inFlight.delete(pending));
              return;
            }
            case "log":
              return appendLog(message.text);
            case "done":
              return end(message.state, message.error, message.state === "succeeded" ? message.result : null);
          }
        });
        connection.onExit((exit) => {
          if (exit.outOfMemory) return end("limit", `the program used more than ${limits.heapMb} MB of memory`);
          end("failed", `the program host stopped unexpectedly${exit.code === null ? "" : ` (code ${exit.code})`}`);
        });

        context.signal.addEventListener("abort", onAbort, { once: true });
        timer = setTimeout(() => end("timeout", `the program ran longer than ${Math.round(limits.timeoutMs / 1000)} s`), limits.timeoutMs);
        if (context.signal.aborted) return onAbort();
        connection.send({ type: "run", runId, program });
      });
    },
  };
}
