// J2-B L2 (C7/A15): context usage, compaction and the handoff dossier.
//
// Rules: compaction is never silent. At COMPACTION_PROPOSAL_RATIO of the model's context
// (`ModelInfo.contextLength` from the catalog; unknown length = no automatic proposal) NOVA
// PROPOSES a summary; the user applies or dismisses it. `/compact` asks for one explicitly. An
// applied summary replaces the covered history in what is sent to the model and is shown as a
// summary card (never as if the model had said it). Large tool results may be pruned (kept head +
// tail, the full output stays an artifact); every pruning is listed. Switching model mid-mission
// produces a handoff dossier the next model starts from. Reasoning content is never part of a
// summary (ADR-008: it is never stored).
import { z } from "zod";
import { EntityIdSchema, ModelIdSchema } from "./ids";
import type { RelativePath } from "./paths";

/** Share of the context window at which a compaction is proposed. */
export const COMPACTION_PROPOSAL_RATIO = 0.8;

export const COMPACTION_LIMITS = {
  /** Longest summary kept (characters). */
  summaryMaxChars: 20_000,
  /** Tool results larger than this may be pruned to head + tail. */
  pruneThresholdChars: 8_000,
  /** Characters kept at each end of a pruned result. */
  pruneKeepChars: 1_500,
  /** User instructions for a manual /compact. */
  instructionsMaxChars: 2_000,
} as const;

export type ContextTarget =
  | { kind: "mission"; missionId: string }
  | { kind: "conversation"; conversationId: string };

export const ContextTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("mission"), missionId: EntityIdSchema }),
  z.object({ kind: z.literal("conversation"), conversationId: EntityIdSchema }),
]);

/**
 * How full the context is. `usedTokens` comes from the provider's last reported prompt usage
 * (`provider_usage`) or a local estimate (`estimate`, shown as such); `unknown` = neither.
 */
export interface ContextUsage {
  target: ContextTarget;
  modelId: string | null;
  usedTokens: number | null;
  contextLength: number | null;
  /** usedTokens / contextLength; null when either is unknown. */
  ratio: number | null;
  source: "provider_usage" | "estimate" | "unknown";
  /** True when ratio >= COMPACTION_PROPOSAL_RATIO and no proposal is pending or applied since. */
  proposalDue: boolean;
  measuredAt: number;
}

export type CompactionKind = "compaction" | "handoff";
export type CompactionReason = "proposed" | "manual" | "model_switch";
export type CompactionStatus = "proposed" | "applied" | "dismissed";

export interface PrunedToolResult {
  toolCallId: string;
  tool: string;
  originalChars: number;
  keptChars: number;
  /** Artifact holding the full output, when one exists. */
  artifactId: string | null;
}

export interface CompactionSummary {
  id: string;
  target: ContextTarget;
  kind: CompactionKind;
  reason: CompactionReason;
  status: CompactionStatus;
  /** Model-written summary (redacted, ≤ COMPACTION_LIMITS.summaryMaxChars). */
  summary: string;
  /** Model that wrote the summary; null = unknown. */
  summarizerModelId: string | null;
  fromModelId: string | null;
  toModelId: string | null;
  /** Last mission event seq / message seq the summary covers. */
  coveredUntilSeq: number;
  tokensBefore: number | null;
  tokensAfter: number | null;
  pruned: PrunedToolResult[];
  /** Cost of the summarizing call; null = unknown. */
  costUsd: number | null;
  createdAt: number;
  decidedAt: number | null;
}

/** A15: what the next model needs to continue a mission. Each list is bounded by the producer. */
export interface HandoffDossier {
  summaryId: string;
  missionId: string;
  fromModelId: string | null;
  toModelId: string;
  goal: string;
  done: string[];
  remaining: string[];
  decisions: string[];
  filesTouched: RelativePath[];
  openQuestions: string[];
  createdAt: number;
}

export const ContextUsageRequestSchema = z.object({ target: ContextTargetSchema });
export const CompactRequestSchema = z.object({
  target: ContextTargetSchema,
  /** Model that writes the summary (usually the current one). */
  modelId: ModelIdSchema,
  instructions: z.string().trim().max(COMPACTION_LIMITS.instructionsMaxChars).nullable(),
});
export const CompactionDecideRequestSchema = z.object({
  summaryId: EntityIdSchema,
  decision: z.enum(["apply", "dismiss"]),
});
export const CompactionsListRequestSchema = z.object({ target: ContextTargetSchema });
export const HandoffRequestSchema = z.object({ missionId: EntityIdSchema, toModelId: ModelIdSchema });

export type ContextUsageRequest = z.infer<typeof ContextUsageRequestSchema>;
export type CompactRequest = z.infer<typeof CompactRequestSchema>;
export type CompactionDecideRequest = z.infer<typeof CompactionDecideRequestSchema>;
export type CompactionsListRequest = z.infer<typeof CompactionsListRequestSchema>;
export type HandoffRequest = z.infer<typeof HandoffRequestSchema>;

/** Pushed on `context.onEvent` (missions also journal the mission ones as mission events). */
export type ContextEvent =
  | { type: "context.usage"; usage: ContextUsage }
  | { type: "compaction.updated"; summary: CompactionSummary };
