// git.* in main (A5): status and diff for the Git panel, plus commit/branch for the agent tools.
// Uses the system `git` (no push, fetch or stash, ever); `available: false` hides the panel.
import type { RelativePath } from "@nova/shared";
import { createIgnoreMatcher, type GitClient, type GitCommitResult } from "@nova/workspace";
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
    async commit(workspaceId, request) {
      const workspaceRoot = await root(workspaceId);
      // C8 (`.novaignore` read now, defaults always): excluded files never enter a commit.
      const matcher = createIgnoreMatcher(workspaceRoot);
      await asService(matcher.load(""));
      return asService(git.commit(workspaceRoot, { ...request, isExcluded: (path) => matcher.isExcluded(path) }));
    },
  };
}
