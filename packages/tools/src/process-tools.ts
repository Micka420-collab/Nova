// L1 — executors of process_list, process_output and process_stop over `ToolDeps.processes`.
// Owned by lane L1. Until implemented, no executor is registered: the tools are never offered.
import type { ToolDeps } from "./apis";
import type { ToolExecutor } from "./index";

export function createProcessExecutors(_deps: ToolDeps): ToolExecutor[] {
  return [];
}
