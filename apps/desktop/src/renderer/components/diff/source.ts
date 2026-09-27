// Where the mission's diff comes from. `missions.diff` (main) gives the mission's own change per
// file — content before its first write → disk now — with the SAME hunks `missions.review`
// reverts; it is the source of the review. The git-backed source (disk vs HEAD) remains for
// callers that only have git.
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
  /**
   * "mission": before the mission → now (hunk indexes are the review's).
   * "git": disk vs last commit (may include the user's own uncommitted edits).
   */
  kind: "mission" | "git" | "none";
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

const MISSING_FROM_MAIN = {
  binary: "binary",
  too_large: "unreadable",
  unreadable: "unreadable",
  no_change: "no_change",
} as const;

/** The mission's own diff from main (`missions.diff`); files the events name but main does not know stay listed. */
export function missionDiffSource(client: NovaApi): MissionDiffSource {
  return {
    kind: "mission",
    async load(missionId, files) {
      const diff = await client.missions.diff({ missionId });
      const byPath = new Map(diff.files.map((file) => [file.path, file]));
      return files.map((touch): MissionDiffFile => {
        const file = byPath.get(touch.path);
        if (!file) return { touch, diff: null, missing: "no_change", truncated: false };
        if (file.patch === null) return { touch, diff: null, missing: file.missing ? MISSING_FROM_MAIN[file.missing] : "unreadable", truncated: false };
        const parsed = parseUnifiedDiff(file.patch)[0] ?? null;
        return { touch, diff: parsed, missing: parsed ? null : "unreadable", truncated: false };
      });
    },
  };
}
