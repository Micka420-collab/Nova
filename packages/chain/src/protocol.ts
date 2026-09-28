// Messages between main (ChainRunner) and one chain-host process. One process runs ONE program and
// is killed afterwards: nothing survives from one program to the next.
//
// Everything that crosses is plain data (strings, numbers, booleans). The host never trusts main's
// words about what a tool did beyond `ok` + `content`, and main never trusts the host: every message
// is validated here before it is acted on (a compromised host can only ask for tool calls, which
// the gateway gates like any other call).
import { CHAIN_LIMITS, type ChainRunState } from "@nova/shared";
import { z } from "@nova/tools";

/** main → chain-host. */
export type ChainHostRequest =
  | { type: "run"; runId: string; program: string }
  | { type: "tool.result"; runId: string; requestId: string; ok: boolean; content: string };

/** chain-host → main. */
export type ChainHostMessage =
  /** The host listens (sent once, before anything else). */
  | { type: "ready" }
  /** `nova.<tool>(args)`: the arguments as the JSON text the program produced. */
  | { type: "tool.call"; runId: string; requestId: string; tool: string; argsJson: string }
  | { type: "log"; runId: string; text: string }
  | { type: "done"; runId: string; state: ChainRunState; result: string | null; error: string | null };

export type ChainProgramCheck = { ok: true } | { ok: false; reason: "too_large" | "syntax" | "forbidden_syntax"; detail: string };

/** Hard caps on what a host may send, whatever it claims (main re-caps the content anyway). */
const TEXT_MAX = 4 * CHAIN_LIMITS.resultMaxChars;
const ID_MAX = 128;

const ChainRunStateSchema = z.enum(["succeeded", "failed", "timeout", "cancelled", "limit"]);

export const ChainHostMessageSchema: z.ZodType<ChainHostMessage> = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready") }),
  z.object({
    type: z.literal("tool.call"),
    runId: z.string().max(ID_MAX),
    requestId: z.string().max(ID_MAX),
    tool: z.string().max(ID_MAX),
    argsJson: z.string().max(TEXT_MAX),
  }),
  z.object({ type: z.literal("log"), runId: z.string().max(ID_MAX), text: z.string().max(TEXT_MAX) }),
  z.object({
    type: z.literal("done"),
    runId: z.string().max(ID_MAX),
    state: ChainRunStateSchema,
    result: z.string().max(TEXT_MAX).nullable(),
    error: z.string().max(TEXT_MAX).nullable(),
  }),
]);

export const ChainHostRequestSchema: z.ZodType<ChainHostRequest> = z.discriminatedUnion("type", [
  z.object({ type: z.literal("run"), runId: z.string().max(ID_MAX), program: z.string().max(CHAIN_LIMITS.programMaxChars) }),
  z.object({
    type: z.literal("tool.result"),
    runId: z.string().max(ID_MAX),
    requestId: z.string().max(ID_MAX),
    ok: z.boolean(),
    content: z.string(),
  }),
]);
