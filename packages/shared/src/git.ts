// Git state read through the system `git` CLI (porcelain v2), relative paths only.
import { z } from "zod";
import { RelativeEntryPathSchema, type RelativePath } from "./paths";

export type GitChangeKind =
  | "unmodified"
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "copied"
  | "type_changed"
  | "untracked"
  | "ignored"
  | "conflicted";

export interface GitStatusEntry {
  path: RelativePath;
  /** Source path of a rename/copy. */
  origPath: RelativePath | null;
  index: GitChangeKind;
  worktree: GitChangeKind;
}

/**
 * `available: false` when git is missing or the folder is not a repository: the Git panel is then
 * absent (no empty page) and checkpoints remain the restore mechanism.
 */
export type GitStatus =
  | { available: false }
  | {
      available: true;
      /** null on a detached HEAD. */
      branch: string | null;
      upstream: string | null;
      /** null when unknown (no upstream, or never fetched: NOVA does not fetch on its own). */
      ahead: number | null;
      behind: number | null;
      entries: GitStatusEntry[];
      /** More entries than the cap (2 000) were present. */
      truncated: boolean;
    };

export const GitDiffRequestSchema = z.object({
  workspaceId: z.uuid(),
  /** Limit to one file; null = whole work tree. */
  path: RelativeEntryPathSchema.nullable(),
  staged: z.boolean(),
});
export type GitDiffRequest = z.infer<typeof GitDiffRequestSchema>;

export interface GitDiff {
  /** Unified diff (`git diff --no-color`), capped at 1 MB. */
  patch: string;
  truncated: boolean;
  /** Changed files left out of `patch` because they are excluded (C8, `.novaignore`). */
  excluded: RelativePath[];
}
