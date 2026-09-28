// J2-B L5 (A14 bounded): sub-missions. A mission may delegate a sub-goal with the
// `start_submission` tool when its contract enables it. Bounds: depth 1 (a sub-mission never
// delegates), at most SUBMISSION_LIMITS.maxChildren per parent; the child's budget is RESERVED
// from the parent's (shared budget, never added). A child that writes works in its own git
// worktree (data dir, never inside the project); its changes are integrated into the project
// one child at a time, only after its tests pass, and each integration is a checkpointed write
// the user can review like any mission change. Forks (L8) reuse the same link table.
import { z } from "zod";
import { EntityIdSchema } from "./ids";
import type { Mission } from "./missions";

export const SUBMISSION_LIMITS = {
  maxDepth: 1,
  maxChildren: 4,
  /** Children running at the same time. */
  maxParallel: 2,
  goalMaxChars: 4_000,
} as const;

export type MissionLinkKind = "submission" | "fork";

export type SubMissionIntegration =
  /** Read-only child: nothing to integrate. */
  | "not_needed"
  | "pending"
  | "testing"
  | "integrated"
  | "tests_failed"
  | "conflict"
  | "discarded";

export interface MissionLink {
  childMissionId: string;
  parentMissionId: string;
  kind: MissionLinkKind;
  /** Fork only: the parent's event seq the fork starts from. */
  forkSeq: number | null;
  depth: number;
  /** Budget reserved on the parent for this child; null for forks. */
  reservedUsd: number | null;
  /** Worktree folder name under the data dir (display only); null = works in place / read-only. */
  worktree: string | null;
  integration: SubMissionIntegration | null;
  createdAt: number;
  updatedAt: number;
}

export interface MissionTreeNode {
  mission: Mission;
  link: MissionLink | null;
  /** Depth 1: children have no children. Ordered by creation. */
  children: { mission: Mission; link: MissionLink }[];
}

export const MissionTreeRequestSchema = z.object({ missionId: EntityIdSchema });
export const SubMissionIdRequestSchema = z.object({ childMissionId: EntityIdSchema });
export type MissionTreeRequest = z.infer<typeof MissionTreeRequestSchema>;
export type SubMissionIdRequest = z.infer<typeof SubMissionIdRequestSchema>;
