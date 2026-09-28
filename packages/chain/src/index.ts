// @nova/chain — mode « Chaîne » (L4). Owned by lane L4.
//
// A program written by the model runs in an isolated host (utilityProcess `chain-host`, no Node
// APIs exposed to the program: fresh context, no require/import/process/fetch, CHAIN_LIMITS on
// wall time, sync slices, heap and call count). The program's only capability is
// `await nova.<tool>(args)`: each call is posted to main, which runs it through the SAME
// ToolGateway as a direct call (parse → permission engine → approval → checkpoint → executor →
// audit) with `parentCallId` = the run_chain call. Backs `ToolDeps.chain`.
import type { ChainRunState } from "@nova/shared";
import type { ChainApi } from "@nova/tools";

/** main → chain-host. */
export type ChainHostRequest =
  | { type: "run"; runId: string; program: string; tools: string[] }
  | { type: "tool.result"; runId: string; requestId: string; ok: boolean; content: string }
  | { type: "cancel"; runId: string };

/** chain-host → main. */
export type ChainHostMessage =
  | { type: "tool.call"; runId: string; requestId: string; tool: string; args: unknown }
  | { type: "log"; runId: string; text: string }
  | { type: "done"; runId: string; state: ChainRunState; result: string | null; error: string | null };

export type ChainProgramCheck = { ok: true } | { ok: false; reason: "too_large" | "syntax" | "forbidden_syntax"; detail: string };

export type ChainRunner = ChainApi;
