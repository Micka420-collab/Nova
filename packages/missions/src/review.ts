// A11: review of a mission's changes, built from its checkpoints (A10). Per file: the content
// before the mission's first write and after its last one. Decisions keep or revert a whole file
// or single hunks of diff(before → after); a revert never overwrites a file the user changed
// since the mission wrote it (current hash must equal the mission's last after-hash).
import type { Checkpoint, ContentHash, RelativePath, RestoreFileResult, ReviewDecision, ReviewResult } from "@nova/shared";

export interface ReviewFile {
  path: RelativePath;
  /** Content before the mission's first write (null = did not exist). */
  beforeHash: ContentHash | null;
  /** Content after the mission's last write (null = deleted). */
  afterHash: ContentHash | null;
  /** Checkpoints that touched this file, oldest first. */
  checkpointIds: string[];
  /**
   * Each checkpoint starts from the content the previous one left. False when something else
   * changed the file between two mission writes (a command, the user): restoring the checkpoints
   * one by one would then stop midway, leaving a state nobody chose.
   */
  chained: boolean;
}

export interface ReviewModel {
  files: ReviewFile[];
}

/** Workspace operations the review needs (L2: fs-worker hashes, checkpoint restore, hunk revert). */
export interface ReviewFsGate {
  currentHash(workspaceId: string, path: RelativePath): Promise<ContentHash | null>;
  /** L2 checkpoint restore: current must equal the checkpoint's afterHash, else `conflict`. */
  restoreFile(checkpointId: string, path: RelativePath): Promise<RestoreFileResult>;
  /**
   * Reverts hunks of diff(base → current) (hunk indexes in `diffHunks` order) by applying their
   * inverse to the current file, through a new restore point; refuses when the current hash is not
   * `expectedCurrentHash` (nothing written).
   */
  revertHunks(input: {
    workspaceId: string;
    missionId: string;
    path: RelativePath;
    baseHash: ContentHash | null;
    expectedCurrentHash: ContentHash | null;
    hunkIndexes: number[];
  }): Promise<{ status: "reverted" } | { status: "conflict" }>;
}

export function buildReview(checkpoints: readonly Checkpoint[]): ReviewModel {
  const files = new Map<RelativePath, ReviewFile>();
  const ordered = [...checkpoints].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  for (const checkpoint of ordered) {
    for (const file of checkpoint.files) {
      const existing = files.get(file.path);
      if (!existing) {
        files.set(file.path, { path: file.path, beforeHash: file.beforeHash, afterHash: file.afterHash, checkpointIds: [checkpoint.id], chained: true });
      } else {
        if (file.beforeHash !== existing.afterHash) existing.chained = false;
        existing.afterHash = file.afterHash;
        existing.checkpointIds.push(checkpoint.id);
      }
    }
  }
  // Files the mission wrote back to their original content are not changes.
  return { files: [...files.values()].filter((file) => file.beforeHash !== file.afterHash).sort((a, b) => a.path.localeCompare(b.path)) };
}

/**
 * Applies decisions. `kept` changes nothing on disk. A whole-file revert restores the file's
 * checkpoints newest first (each restore checks its own after-hash), only when they form one chain:
 * otherwise it is a conflict and nothing is written (per-hunk revert still works, it diffs against
 * the original content). A file-level decision wins over hunk decisions of the same file.
 */
export async function applyReview(input: {
  workspaceId: string;
  missionId: string;
  model: ReviewModel;
  decisions: readonly ReviewDecision[];
  fs: ReviewFsGate;
}): Promise<ReviewResult> {
  const applied: ReviewDecision[] = [];
  const conflicts: ReviewResult["conflicts"] = [];
  const byPath = new Map<RelativePath, ReviewDecision[]>();
  for (const decision of input.decisions) byPath.set(decision.path, [...(byPath.get(decision.path) ?? []), decision]);

  for (const [path, decisions] of byPath) {
    const file = input.model.files.find((candidate) => candidate.path === path);
    if (!file) {
      for (const decision of decisions) conflicts.push({ path, hunkIndex: decision.hunkIndex });
      continue;
    }
    const whole = decisions.find((decision) => decision.hunkIndex === null);
    const hunks = whole ? [] : decisions.filter((decision) => decision.hunkIndex !== null);
    const reverts = whole ? (whole.decision === "reverted" ? [whole] : []) : hunks.filter((decision) => decision.decision === "reverted");
    const kept = whole ? (whole.decision === "kept" ? [whole] : []) : hunks.filter((decision) => decision.decision === "kept");
    applied.push(...kept);
    if (reverts.length === 0) continue;

    const current = await input.fs.currentHash(input.workspaceId, path);
    if (current !== file.afterHash || (whole && !file.chained)) {
      for (const decision of reverts) conflicts.push({ path, hunkIndex: decision.hunkIndex });
      continue;
    }
    if (whole) {
      let ok = true;
      for (const checkpointId of [...file.checkpointIds].reverse()) {
        const result = await input.fs.restoreFile(checkpointId, path);
        if (result.status !== "restored") {
          ok = false;
          break;
        }
      }
      if (ok) applied.push(whole);
      else conflicts.push({ path, hunkIndex: null });
      continue;
    }
    const outcome = await input.fs.revertHunks({
      workspaceId: input.workspaceId,
      missionId: input.missionId,
      path,
      baseHash: file.beforeHash,
      expectedCurrentHash: current,
      hunkIndexes: reverts.map((decision) => decision.hunkIndex ?? 0),
    });
    if (outcome.status === "reverted") applied.push(...reverts);
    else for (const decision of reverts) conflicts.push({ path, hunkIndex: decision.hunkIndex });
  }
  return { applied, conflicts };
}
