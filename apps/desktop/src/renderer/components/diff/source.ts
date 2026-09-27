// Where the mission's diff comes from. No contract gives the mission's own per-file diff yet
// (proposed: `missions.diff`); until then the git-backed source compares the disk with HEAD for
// each file the mission touched, and says so.
import type { NovaApi } from "@nova/shared";
import type { FileTouch } from "../missions/timeline";
import { createdFileDiff, parseUnifiedDiff, type DiffFileData } from "./parse";

export interface MissionDiffFile {
  touch: FileTouch;
  /** null = no textual diff available for this file (binary, no git, too large, unreadable). */
  diff: DiffFileData | null;
  /** Why `diff` is null, when known. */
  missing: "binary" | "no_git" | "no_change" | "unreadable" | null;
  truncated: boolean;
}

export interface MissionDiffSource {
  /** "git": disk vs last commit (may include the user's own uncommitted edits). */
  kind: "git" | "none";
  load(missionId: string, files: readonly FileTouch[]): Promise<MissionDiffFile[]>;
}

export function gitDiffSource(client: NovaApi, workspaceId: string): MissionDiffSource {
  return {
    kind: "git",
    async load(_missionId, files) {
      return Promise.all(
        files.map(async (touch): Promise<MissionDiffFile> => {
          const { patch, truncated } = await client.git.diff({ workspaceId, path: touch.path, staged: false });
          const parsed = parseUnifiedDiff(patch);
          const diff = parsed.find((file) => file.path === touch.path) ?? parsed[0] ?? null;
          if (diff) return { touch, diff, missing: diff.binary ? "binary" : null, truncated };
          if (touch.change === "created") {
            // Untracked files are absent from `git diff`: the whole content is the addition.
            try {
              const file = await client.files.read({ workspaceId, path: touch.path });
              if (file.binary || file.tooLarge || file.content === null) {
                return { touch, diff: null, missing: file.binary ? "binary" : "unreadable", truncated: false };
              }
              return { touch, diff: createdFileDiff(touch.path, file.content), missing: null, truncated: false };
            } catch {
              return { touch, diff: null, missing: "unreadable", truncated: false };
            }
          }
          return { touch, diff: null, missing: "no_change", truncated };
        }),
      );
    },
  };
}

/** Without git: files and counts from the mission's events, decisions at file level only. */
export const noDiffSource: MissionDiffSource = {
  kind: "none",
  load(_missionId, files) {
    return Promise.resolve(files.map((touch) => ({ touch, diff: null, missing: "no_git" as const, truncated: false })));
  },
};
