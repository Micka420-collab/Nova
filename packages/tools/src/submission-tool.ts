// L5 — executor of `start_submission` over `ToolDeps.submissions`. Owned by lane L5. Until
// implemented, no executor is registered: the tool is never offered.
import type { ToolDeps } from "./apis";
import type { ToolExecutor } from "./index";

export function createSubmissionExecutors(_deps: ToolDeps): ToolExecutor[] {
  return [];
}
