// L5 (A14 bounded) — sub-missions: depth 1, budget reserved from the parent, git worktree for a
// writing child, serialized integration after tests. Owned by lane L5.
// Main side: backs `ToolDeps.submissions` (start_submission) and the `submissions.*` IPC group
// (storage: mission_links).
import type { MissionTreeNode } from "@nova/shared";
import type { SubmissionsApi } from "@nova/tools";

export interface SubmissionsController extends SubmissionsApi {
  tree(missionId: string): Promise<MissionTreeNode>;
  /** One integration at a time (queue); runs the child's tests on its worktree first. */
  integrate(childMissionId: string): Promise<MissionTreeNode>;
  discard(childMissionId: string): Promise<MissionTreeNode>;
}
