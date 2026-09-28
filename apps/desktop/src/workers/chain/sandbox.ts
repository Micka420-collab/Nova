// Host half of the « Chaîne » sandbox: one fresh V8 context per program (no require, import,
// process, fetch, timers, console of the host, nor code generation from strings), entered only
// through timed slices. `microtaskMode: "afterEvaluate"` runs the promise jobs a slice schedules
// INSIDE that slice, so the timeout covers the program's code after each `await` too (a loop after
// a tool result, or `while (true) await null`, is interrupted like a synchronous one).
import { randomBytes } from "node:crypto";
import { Script, constants, createContext, type Context } from "node:vm";
import { CHAIN_PROGRAM_LINE_OFFSET, wrapChainProgram } from "@nova/chain";
import { bridgeSource, type BridgeEvent } from "./bridge";

/** How a slice ended; the events it produced are returned in order either way. */
export type SliceOutcome =
  | { status: "ok"; events: BridgeEvent[] }
  | { status: "timeout"; events: BridgeEvent[] }
  | { status: "failed"; events: BridgeEvent[]; detail: string };

export interface ChainSandbox {
  /** Compiles the program at the context's global scope and runs it until it waits for a tool. */
  start(program: string): SliceOutcome;
  /** Settles one pending `nova.<tool>` call and runs the program until it waits again. */
  deliver(requestId: string, ok: boolean, content: string): SliceOutcome;
}

function key(prefix: string): string {
  return `__nova_${prefix}_${randomBytes(8).toString("hex")}`;
}

function isTimeout(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ERR_SCRIPT_EXECUTION_TIMEOUT";
}

export function createChainSandbox(options: { syncSliceMs: number }): ChainSandbox {
  const context: Context = createContext(constants.DONT_CONTEXTIFY, {
    name: "nova-chain",
    codeGeneration: { strings: false, wasm: false },
    microtaskMode: "afterEvaluate",
  });
  const enterKey = key("enter");
  const deliverKey = key("deliver");
  let events: BridgeEvent[] = [];

  // The only host function the context ever receives. It copies primitives out and never throws.
  const post = (kind: unknown, a: unknown, b: unknown, c: unknown): void => {
    try {
      if (kind === "call" && typeof a === "string" && typeof b === "string" && typeof c === "string") {
        events.push({ kind: "call", id: a, tool: b, argsJson: c });
      } else if (kind === "log" && typeof a === "string") {
        events.push({ kind: "log", text: a });
      } else if (kind === "done" && a === true && (typeof b === "string" || b === null)) {
        events.push({ kind: "done", ok: true, resultJson: b });
      } else if (kind === "done" && a === false && typeof b === "string") {
        events.push({ kind: "done", ok: false, error: b });
      }
    } catch {
      // Nothing to report: a malformed post is dropped.
    }
  };
  const install = new Script(bridgeSource(enterKey, deliverKey), { filename: "nova-bridge.js" }).runInContext(context) as (
    post: (kind: unknown, a: unknown, b: unknown, c: unknown) => void,
  ) => void;
  install(post);

  const slice = (script: () => Script): SliceOutcome => {
    events = [];
    try {
      script().runInContext(context, { timeout: options.syncSliceMs, breakOnSigint: false });
      return { status: "ok", events };
    } catch (error) {
      if (isTimeout(error)) return { status: "timeout", events };
      const detail = error instanceof Error ? error.message : "the program could not run";
      return { status: "failed", events, detail: detail.slice(0, 300) };
    } finally {
      events = [];
    }
  };

  return {
    start(program) {
      return slice(
        () => new Script(`${enterKey}(${wrapChainProgram(program)});`, { filename: "program.js", lineOffset: CHAIN_PROGRAM_LINE_OFFSET }),
      );
    },
    deliver(requestId, ok, content) {
      // Literal arguments: the context receives only its own strings, never a host object.
      return slice(() => new Script(`${deliverKey}(${JSON.stringify(requestId)}, ${ok ? "true" : "false"}, ${JSON.stringify(content)});`));
    },
  };
}
