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
  /** C8 of the workspace (`.novaignore` read now, defaults always). */
  const exclusionOf = async (workspaceRoot: string): Promise<(path: RelativePath) => boolean> => {
    const matcher = createIgnoreMatcher(workspaceRoot);
    await asService(matcher.load(""));
    return (path) => matcher.isExcluded(path);
  };
  return {
    api: {
      status: async ({ workspaceId }) => asService(git.status(await root(workspaceId))),
      // Excluded files are never read, a diff included: their hunks are left out.
      async diff({ workspaceId, path, staged }) {
        const workspaceRoot = await root(workspaceId);
        return asService(git.diff(workspaceRoot, { path, staged, isExcluded: await exclusionOf(workspaceRoot) }));
      },
    },
    branch: async (workspaceId) => asService(git.branch(await root(workspaceId))),
    // Excluded files never enter a commit.
    async commit(workspaceId, request) {
      const workspaceRoot = await root(workspaceId);
      return asService(git.commit(workspaceRoot, { ...request, isExcluded: await exclusionOf(workspaceRoot) }));
    },
  };
}
