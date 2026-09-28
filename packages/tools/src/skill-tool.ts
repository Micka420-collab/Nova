// L3 — executor of the `skill` tool (progressive loading) over `ToolDeps.skills`.
// Owned by lane L3. Until implemented, no executor is registered: the tool is never offered.
import type { ToolDeps } from "./apis";
import type { ToolExecutor } from "./index";

export function createSkillExecutors(_deps: ToolDeps): ToolExecutor[] {
  return [];
}
