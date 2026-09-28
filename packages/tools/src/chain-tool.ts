// L4 — executor of `run_chain` over `ToolDeps.chain`. Owned by lane L4. Until implemented, no
// executor is registered: the tool is never offered even when the contract enables « Chaîne ».
import type { ToolDeps } from "./apis";
import type { ToolExecutor } from "./index";

export function createChainExecutors(_deps: ToolDeps): ToolExecutor[] {
  return [];
}
