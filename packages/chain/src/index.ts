// @nova/chain — mode « Chaîne » (L4).
//
// A program written by the model runs in an isolated host (chain-host utilityProcess, one fresh
// process per program, killed afterwards): the program is compiled in a fresh V8 context without
// require/import/process/fetch/timers/code generation, and CHAIN_LIMITS cap its wall time, its
// computation between two tool calls, its heap and its call count. Its only capability is
// `await nova.<tool>(args)`: each call is posted to main, which runs it through the SAME
// ToolGateway as a direct call (parse → permission engine → approval → checkpoint → executor →
// audit) with `parentCallId` = the run_chain call. Backs `ToolDeps.chain`.
export { chainProgramPreview, checkChainProgram, wrapChainProgram, CHAIN_PROGRAM_LINE_OFFSET } from "./program";
export {
  ChainHostMessageSchema,
  ChainHostRequestSchema,
  type ChainHostMessage,
  type ChainHostRequest,
  type ChainProgramCheck,
} from "./protocol";
export {
  createChainRunner,
  type ChainHostConnection,
  type ChainHostExit,
  type ChainLimits,
  type ChainNestedRunContext,
  type ChainRunOutcome,
  type ChainRunner,
  type ChainRunnerDeps,
} from "./runner";
