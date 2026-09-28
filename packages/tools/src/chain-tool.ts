// L4 — executor of `run_chain` (mode « Chaîne ») over `ToolDeps.chain`. Offered only when the
// mission contract enables it (missionToolSet) and the chain host is wired.
//
// The executor never runs the program itself: `ToolDeps.chain` does, in an isolated host, and every
// `nova.<tool>(args)` of the program re-enters the gateway through `context.runNested` (same
// parsing, permission engine, approvals, checkpoints and audit, parent = this call). It journals
// `chain.started` / `chain.finished` so the timeline shows the program and its outcome even when
// the host fails, and marks its result untrusted when any inner result was.
import { z } from "zod";
import {
  CHAIN_FORBIDDEN_TOOLS,
  CHAIN_LIMITS,
  redactSecrets,
  type ChainRunSummary,
  type JsonSchemaObject,
  type Provenance,
  type ToolResult,
} from "@nova/shared";
import type { ChainRunContext, ToolDeps } from "./apis";
import { capText, makeResult, provenance } from "./content";
import type { ToolExecutor } from "./index";

const PREVIEW_MAX = 2_000;

const schema = z
  .object({
    program: z
      .string()
      .min(1)
      .max(CHAIN_LIMITS.programMaxChars)
      .describe("body of an async JavaScript function; call tools with `await nova.<tool_name>({ ...arguments })`"),
  })
  .strict();

type ChainArgs = z.output<typeof schema>;

const DESCRIPTION = [
  "Run ONE JavaScript program that chains several of your tools in a single step: use it for repetitive or",
  "data-dependent sequences (read many files, filter, then act) instead of many separate calls.",
  "The program is the body of an async function. Call a tool with `await nova.<tool_name>({ ...arguments })`, using",
  "the same names and arguments as your tools; each call resolves to the tool's text result (a string) and throws an",
  "Error carrying the error text when the tool fails or is refused. Every call goes through the same permission",
  "checks and approvals as a direct call. `console.log(...)` output and the program's `return` value",
  "(JSON-serializable) come back to you.",
  "Only `nova`, `console` and plain JavaScript exist: no require, import, process, fetch, filesystem or timers.",
  `Limits: ${CHAIN_LIMITS.maxToolCalls} tool calls, ${CHAIN_LIMITS.timeoutMs / 1000} s in total, ${CHAIN_LIMITS.syncSliceMs / 1000} s of`,
  `computation between two tool calls, ${CHAIN_LIMITS.heapMb} MB of memory, ${CHAIN_LIMITS.programMaxChars} characters of program.`,
  `${CHAIN_FORBIDDEN_TOOLS.join(" and ")} cannot be called from a program.`,
].join(" ");

function inputSchema(): JsonSchemaObject {
  const json = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
  delete json["$schema"];
  return json as unknown as JsonSchemaObject;
}

function preview(text: string): string {
  const redacted = redactSecrets(text);
  return redacted.length > PREVIEW_MAX ? `${redacted.slice(0, PREVIEW_MAX - 1)}…` : redacted;
}

const STATE_TEXT: Record<ChainRunSummary["state"], string> = {
  succeeded: "The program finished",
  failed: "The program failed",
  timeout: "The program was stopped: time limit reached",
  cancelled: "The program was stopped by the user",
  limit: "The program was stopped: limit reached",
};

function modelContent(summary: ChainRunSummary, result: string | null, logs: string): string {
  const lines = [`${STATE_TEXT[summary.state]} after ${summary.toolCalls} tool call${summary.toolCalls === 1 ? "" : "s"}.`];
  if (summary.error) lines.push(`Error: ${summary.error}`);
  if (summary.state === "succeeded") lines.push(result === null ? "Return value: none." : `Return value (JSON):\n${result}`);
  if (logs) lines.push(`Console output:\n${logs}`);
  if (summary.state !== "succeeded" && summary.toolCalls > 0) {
    lines.push("Calls made before the end already took effect; check their results before retrying.");
  }
  return lines.join("\n");
}

export function createChainExecutors(deps: ToolDeps): ToolExecutor[] {
  const chain = deps.chain;
  if (!chain) return [];

  const executor: ToolExecutor<ChainArgs> = {
    name: "run_chain",
    operation: "read",
    definition: { name: "run_chain", description: DESCRIPTION, inputSchema: inputSchema(), operation: "read" },
    argsSchema: schema,
    // The program itself touches nothing: each of its calls is evaluated on its own targets.
    permissionFacts: () => [{}],
    checkpointPaths: () => [],
    async execute(args, context) {
      const started = Date.now();
      const runNested = context.runNested;
      context.record?.({ type: "chain.started", callId: context.callId, programPreview: preview(args.program) });

      // Inner results that came from outside NOVA (files, web, MCP) make the program's output
      // untrusted as well: it is fenced as data like theirs.
      const taint: { origin: Provenance | null } = { origin: null };
      let outcome: { summary: ChainRunSummary; result: string | null; logs: string };
      if (!runNested) {
        outcome = {
          summary: { callId: context.callId, state: "failed", toolCalls: 0, durationMs: 0, error: "program calls cannot be relayed in this session" },
          result: null,
          logs: "",
        };
      } else {
        const runContext: ChainRunContext & { runNested: typeof runNested } = {
          workspaceId: context.workspaceId,
          missionId: context.missionId,
          callId: context.callId,
          signal: context.signal,
          runNested: async (call): Promise<ToolResult> => {
            const result = await runNested(call);
            if (result.provenance.untrusted) taint.origin ??= result.provenance;
            return result;
          },
        };
        try {
          outcome = await chain.run(args.program, runContext);
        } catch {
          outcome = {
            summary: {
              callId: context.callId,
              state: context.signal.aborted ? "cancelled" : "failed",
              toolCalls: 0,
              durationMs: Date.now() - started,
              error: context.signal.aborted ? "stopped by the user" : "the program host is unavailable",
            },
            result: null,
            logs: "",
          };
        }
      }
      const { summary, result, logs } = outcome;
      context.record?.({ type: "chain.finished", summary });

      const resultPreview = result === null ? null : capText(redactSecrets(result), PREVIEW_MAX).text;
      const origin: Provenance = taint.origin ? { ...taint.origin, ref: null } : provenance("nova", null);
      return makeResult({
        callId: context.callId,
        ok: summary.state === "succeeded",
        content: modelContent(summary, result, logs),
        display: { kind: "chain", state: summary.state, toolCalls: summary.toolCalls, durationMs: summary.durationMs, resultPreview },
        provenance: origin,
        durationMs: Date.now() - started,
      });
    },
  };
  return [executor as ToolExecutor];
}
