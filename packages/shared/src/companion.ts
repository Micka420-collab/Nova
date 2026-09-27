// Nomi acts (N1/N2/N3/N10/N11). Every suggestion references a recorded signal with its evidence;
// nothing is triggered without a click; at most one suggestion is visible at a time and suggestions
// are rate-limited by the signal bus in main (@nova/companion).
import { z } from "zod";
import { EntityIdSchema } from "./ids";
import { RelativeEntryPathSchema, type RelativePath } from "./paths";
import { WORK_MODES, type WorkMode } from "./missions";

export type CompanionSignalKind =
  | "test_failed"
  | "process_crashed"
  | "mission_waiting"
  | "mission_done"
  | "mission_failed"
  | "budget_reached"
  | "approval_pending";

/** What recorded fact the signal points to. */
export type CompanionSourceRef =
  | { kind: "tool_call"; toolCallId: string; missionId: string }
  | { kind: "terminal"; sessionId: string }
  | { kind: "mission"; missionId: string }
  | { kind: "approval"; approvalId: string; missionId: string | null };

export interface CompanionSignal {
  id: string;
  kind: CompanionSignalKind;
  workspaceId: string | null;
  sourceRef: CompanionSourceRef;
  /** Proof shown with the suggestion: output excerpt (redacted, ≤ 2 000 chars) and path if any. */
  evidence: { excerpt: string | null; path: RelativePath | null };
  state: "new" | "seen" | "ignored";
  createdAt: number;
}

export type CompanionAction =
  | { type: "start_mission"; workspaceId: string; mode: WorkMode; goal: string }
  | { type: "stop_mission"; missionId: string }
  | { type: "open_approval"; approvalId: string }
  | { type: "explain_error"; sourceRef: CompanionSourceRef }
  | { type: "show_changes"; missionId: string }
  | { type: "open_diff"; missionId: string; path: RelativePath }
  | { type: "watch_command"; sourceRef: CompanionSourceRef };

export interface CompanionSuggestion {
  id: string;
  signalId: string;
  /** French, short, factual (N11: no guilt, no streaks, no urgency). */
  text: string;
  action: CompanionAction;
  status: "proposed" | "accepted" | "dismissed" | "snoozed";
  createdAt: number;
}

/** Pushed on `companion.onEvent`. */
export type CompanionEvent =
  | { type: "signal"; signal: CompanionSignal }
  | { type: "suggestion"; suggestion: CompanionSuggestion }
  | { type: "suggestion.cleared"; suggestionId: string };

export interface CompanionState {
  /** The single visible suggestion, if any. */
  suggestion: CompanionSuggestion | null;
  /** Recent signals (newest first, ≤ 50) for the text-only view (scenario 14). */
  signals: CompanionSignal[];
}

export type CompanionNoticeKind =
  | "approval"
  | "mission_succeeded"
  | "mission_failed"
  | "mission_suspended"
  | "watch_done"
  | "chat_failed";

export type CompanionNoticeDelivery = "bubble" | "system" | "held";

export interface CompanionNoticeInput {
  kind: CompanionNoticeKind;
  entityType: "mission" | "approval" | "terminal" | "conversation";
  entityId: string;
  /** Coalescing group: the mission id when there is one, else the entity id. */
  groupKey: string;
  /** Title and fact only: never conversation content (NOMI.md §10). */
  text: string;
}

/** P13: every fact Nomi notified (or held in quiet mode) can be read back in the app. */
export interface CompanionNotice extends CompanionNoticeInput {
  id: string;
  createdAt: number;
  delivered: CompanionNoticeDelivery;
  readAt: number | null;
}

/** P5: report on this terminal session's next exit (main resolves its workspace and command). */
export const CompanionWatchRequestSchema = z.object({ sessionId: EntityIdSchema });
export type CompanionWatchRequest = z.infer<typeof CompanionWatchRequestSchema>;
export interface CompanionWatchResult {
  /** `none`: no running session with this id. */
  status: "started" | "already" | "none";
  command: string[] | null;
}

/** Quiet mode (P13): system notifications held until `until` (epoch ms); null = off. */
export const CompanionQuietRequestSchema = z.object({ until: z.int().min(0).nullable() });
export type CompanionQuietRequest = z.infer<typeof CompanionQuietRequestSchema>;

export const CompanionStateRequestSchema = z.object({ workspaceId: EntityIdSchema.nullable() });
export type CompanionStateRequest = z.infer<typeof CompanionStateRequestSchema>;

/**
 * The user's answer to a suggestion. `accept` performs its action (through the same IPC services as
 * the rest of the app, same permissions); `mute_kind` stops suggestions for this signal kind.
 */
export const CompanionActRequestSchema = z.object({
  suggestionId: EntityIdSchema,
  response: z.enum(["accept", "snooze", "dismiss", "mute_kind"]),
});
export type CompanionActRequest = z.infer<typeof CompanionActRequestSchema>;

/**
 * `performedByMain`: the action ran in main (start/stop mission). Otherwise `navigate` tells the
 * renderer which view to open (approval card, changes, diff, terminal, explanation).
 */
export interface CompanionActResult {
  suggestion: CompanionSuggestion;
  performedByMain: boolean;
  navigate: CompanionAction | null;
}

/** Runtime validation of an action (used by main before performing it). */
const SourceRefSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("tool_call"), toolCallId: EntityIdSchema, missionId: EntityIdSchema }),
  z.object({ kind: z.literal("terminal"), sessionId: EntityIdSchema }),
  z.object({ kind: z.literal("mission"), missionId: EntityIdSchema }),
  z.object({ kind: z.literal("approval"), approvalId: EntityIdSchema, missionId: EntityIdSchema.nullable() }),
]);
export const CompanionActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("start_mission"),
    workspaceId: EntityIdSchema,
    mode: z.enum(WORK_MODES),
    goal: z.string().min(1).max(20_000),
  }),
  z.object({ type: z.literal("stop_mission"), missionId: EntityIdSchema }),
  z.object({ type: z.literal("open_approval"), approvalId: EntityIdSchema }),
  z.object({ type: z.literal("explain_error"), sourceRef: SourceRefSchema }),
  z.object({ type: z.literal("show_changes"), missionId: EntityIdSchema }),
  z.object({ type: z.literal("open_diff"), missionId: EntityIdSchema, path: RelativeEntryPathSchema }),
  z.object({ type: z.literal("watch_command"), sourceRef: SourceRefSchema }),
]);
