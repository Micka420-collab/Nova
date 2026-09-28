// J2-B L4: mode « Chaîne ». When the mission contract enables it, the model may call `run_chain`
// with ONE JavaScript program that chains several NOVA tools. The program runs in an isolated
// worker (no Node APIs, no require/import, no network, no timers beyond the runner's own; wall
// time and heap capped by CHAIN_LIMITS). Its only capability is `nova.<tool>(args)`, a proxy that
// sends each call back to main's ToolGateway: same parsing, same permission engine, same
// approvals, same checkpoints and audit as a direct tool call. Every inner call appears in the
// mission timeline (`tool.requested` with `parentCallId` = the run_chain call).
import type { ToolName } from "./tools";

export const CHAIN_LIMITS = {
  programMaxChars: 20_000,
  /** Wall time of the whole program, tool calls included. */
  timeoutMs: 5 * 60_000,
  /** CPU time the program may spend between two tool calls. */
  syncSliceMs: 2_000,
  maxToolCalls: 50,
  heapMb: 64,
  /** What the program returns (JSON.stringify) and logs, each capped. */
  resultMaxChars: 20_000,
  logMaxChars: 10_000,
} as const;

/** Tools a chain may never call (no nesting, no delegation from inside a program). */
export const CHAIN_FORBIDDEN_TOOLS: readonly ToolName[] = ["run_chain", "start_submission"];

export type ChainRunState = "succeeded" | "failed" | "timeout" | "cancelled" | "limit";

export interface ChainRunSummary {
  /** The run_chain tool call id. */
  callId: string;
  state: ChainRunState;
  toolCalls: number;
  durationMs: number;
  /** Program error (message only, no stack paths), redacted; null on success. */
  error: string | null;
}
