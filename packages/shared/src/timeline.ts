// J2-B L8: missions "jusqu'à preuve" and the timeline.
// - Auto-continuation (opt-in per mission): when a round ends with checkable acceptance criteria
//   still unproven, the runtime starts another round, bounded by `maxRounds` AND by a budget cap
//   inside the mission budget; it stops as soon as every checkable criterion is proven, or on
//   no-progress. `manual` criteria never trigger a round (they stay "to confirm by you").
// - Timeline: search over the journal of every mission (FTS on stored events), and fork a
//   mission from one of its events (the new mission starts in `ready` from a summary of the
//   events up to that seq; the original is never modified).
import { z } from "zod";
import { EntityIdSchema, ModelIdSchema } from "./ids";
import type { MissionEventType } from "./missions";

export const AUTO_CONTINUE_LIMITS = { maxRounds: 10 } as const;

export const AutoContinueOptionsSchema = z.object({
  maxRounds: z.int().min(1).max(AUTO_CONTINUE_LIMITS.maxRounds),
  /** Cap for all continuation rounds together, inside the mission budget (never on top of it). */
  budgetUsd: z.number().min(0).max(1_000),
});
export type AutoContinueOptions = z.infer<typeof AutoContinueOptionsSchema>;

export type ContinuationStopReason = "proven" | "max_rounds" | "budget" | "no_progress" | "user" | "manual_only";

export const TimelineSearchRequestSchema = z.object({
  workspaceId: EntityIdSchema.nullable(),
  missionId: EntityIdSchema.nullable(),
  query: z.string().trim().min(1).max(200),
  limit: z.int().min(1).max(200),
});
export type TimelineSearchRequest = z.infer<typeof TimelineSearchRequestSchema>;

export interface TimelineHit {
  missionId: string;
  missionTitle: string;
  seq: number;
  type: MissionEventType;
  at: number;
  /** Redacted excerpt around the match (≤ 300 characters). */
  snippet: string;
}

export const MissionForkRequestSchema = z.object({
  missionId: EntityIdSchema,
  /** Seq of the event the fork starts after (must belong to the mission). */
  atSeq: z.int().min(1),
  /** New goal; null = the original goal. */
  goal: z.string().trim().min(1).max(20_000).nullable(),
  /** null = the original model. */
  modelId: ModelIdSchema.nullable(),
});
export type MissionForkRequest = z.infer<typeof MissionForkRequestSchema>;
