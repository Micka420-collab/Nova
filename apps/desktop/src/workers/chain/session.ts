// One chain-host process = one session = one program. The session turns bridge events into host
// messages and enforces the limits it can see from inside: computation per slice (the sandbox
// timeout), heap after each slice, tool-call count, result size. Main enforces call count and wall
// time again and kills the process afterwards (./../chain-host.ts only wires the parent port).
import { ChainHostRequestSchema, checkChainProgram, type ChainHostMessage, type ChainLimits } from "@nova/chain";
import { CHAIN_LIMITS, type ChainRunState } from "@nova/shared";
import { createChainSandbox, type ChainSandbox, type SliceOutcome } from "./sandbox";

export interface ChainHostSessionDeps {
  post(message: ChainHostMessage): void;
  /** Heap the program is charged with (the host process's used heap, or a test's measure). */
  heapUsedBytes(): number;
  limits?: Partial<ChainLimits>;
}

export interface ChainHostSession {
  /** A message from main (validated here; anything else is ignored). */
  handle(message: unknown): void;
}

const MB = 1024 * 1024;

export function createChainHostSession(deps: ChainHostSessionDeps): ChainHostSession {
  const limits: ChainLimits = { ...CHAIN_LIMITS, ...deps.limits };
  let run: { runId: string; sandbox: ChainSandbox; calls: number; ended: boolean } | null = null;

  const end = (state: ChainRunState, result: string | null, error: string | null): void => {
    if (!run || run.ended) return;
    run.ended = true;
    const bounded = result !== null && result.length > limits.resultMaxChars ? null : result;
    const tooLarge = result !== null && bounded === null;
    deps.post({
      type: "done",
      runId: run.runId,
      state: tooLarge ? "limit" : state,
      result: bounded,
      error: tooLarge ? `the return value has ${result.length} characters; the limit is ${limits.resultMaxChars}` : error,
    });
  };

  const apply = (outcome: SliceOutcome): void => {
    const current = run;
    if (!current) return;
    for (const event of outcome.events) {
      if (current.ended) return;
      switch (event.kind) {
        case "log":
          deps.post({ type: "log", runId: current.runId, text: event.text.slice(0, limits.logMaxChars) });
          break;
        case "call":
          current.calls += 1;
          if (current.calls > limits.maxToolCalls) {
            end("limit", null, `the program made more than ${limits.maxToolCalls} tool calls`);
            return;
          }
          deps.post({ type: "tool.call", runId: current.runId, requestId: event.id, tool: event.tool, argsJson: event.argsJson });
          break;
        case "done":
          if (event.ok) end("succeeded", event.resultJson, null);
          else end("failed", null, event.error);
          break;
      }
    }
    if (outcome.status === "timeout") {
      end("timeout", null, `the program computed for more than ${limits.syncSliceMs / 1000} s without waiting for a tool`);
      return;
    }
    if (outcome.status === "failed") {
      end("failed", null, outcome.detail);
      return;
    }
    if (deps.heapUsedBytes() > limits.heapMb * MB) end("limit", null, `the program used more than ${limits.heapMb} MB of memory`);
  };

  return {
    handle(raw) {
      const parsed = ChainHostRequestSchema.safeParse(raw);
      if (!parsed.success) return;
      const message = parsed.data;
      if (message.type === "run") {
        // One program per process: a second run is ignored (main never sends one).
        if (run) return;
        const check = checkChainProgram(message.program, limits.programMaxChars);
        if (!check.ok) {
          deps.post({ type: "done", runId: message.runId, state: "failed", result: null, error: `${check.reason}: ${check.detail}` });
          return;
        }
        run = { runId: message.runId, sandbox: createChainSandbox({ syncSliceMs: limits.syncSliceMs }), calls: 0, ended: false };
        apply(run.sandbox.start(message.program));
        return;
      }
      if (!run || run.ended || message.runId !== run.runId) return;
      apply(run.sandbox.deliver(message.requestId, message.ok, message.content));
    },
  };
}
