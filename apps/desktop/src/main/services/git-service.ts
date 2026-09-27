// git.* in main (A5): status and diff for the Git panel, plus commit/branch for the agent tools.
// Uses the system `git` (no push, fetch or stash, ever); `available: false` hides the panel.
import type { RelativePath } from "@nova/shared";
import type { GitClient, GitCommitResult } from "@nova/workspace";
import type { AtelierApi } from "../api";
import { asService, type WorkspaceService } from "./workspace-service";

export interface GitService {
  api: AtelierApi["git"];
  branch(workspaceId: string): Promise<string | null>;
  /** Caller (tools lane) has obtained the `git_mutation` permission first. */
  commit(workspaceId: string, request: { message: string; paths: RelativePath[] | "all" }): Promise<GitCommitResult>;
}

export function createGitService(deps: { workspaces: Pick<WorkspaceService, "rootOf">; git: GitClient }): GitService {
  const { git } = deps;
  const root = (workspaceId: string): Promise<string> => deps.workspaces.rootOf(workspaceId);
  return {
    api: {
      status: async ({ workspaceId }) => asService(git.status(await root(workspaceId))),
      diff: async ({ workspaceId, path, staged }) => asService(git.diff(await root(workspaceId), { path, staged })),
    },
    branch: async (workspaceId) => asService(git.branch(await root(workspaceId))),
    commit: async (workspaceId, request) => asService(git.commit(await root(workspaceId), request)),
  };
}
