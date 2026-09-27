// @nova/companion — Nomi's pure logic (N1/N2/N3/N10/N11), shared by main and the renderer (no
// Node API): facts projected from recorded runtime events, signal producers, deterministic
// suggestion rules, local-first error explanations, change summaries, watched-command reports,
// the notification policy, the quick-actions menu and the action executor.
//
// Contract:
// - Signals come only from recorded facts (tool results, process exits, mission events,
//   approvals); main stores each one (`signals`) before any suggestion refers to it.
// - At most one visible suggestion, at most three ranked; rate-limited; muted kinds; nothing
//   happens without a click; no network request to produce a signal.
// - Every action ends in a visible ActionOutcome.
// - N11 anti-manipulation: no guilt, streaks, scores or attention-seeking notifications; all copy
//   is content-tested (manipulation.ts).
export { NOMI_ACTIVITIES, WORKING_ACTIVITIES, activityForTool, activityForToolStart, type NomiActivity } from "./activity";
export {
  performNomiAction,
  explainSourceFromEvents,
  outcomeFromError,
  type ActionOutcome,
  type NomiAction,
  type NomiActionPorts,
} from "./act";
export {
  missionFactsFromEvents,
  summarizeConversation,
  summarizeMissionChanges,
  type ChangeLine,
  type ChangeTarget,
  type ConversationFacts,
} from "./changes";
export { NOMI_COPY } from "./copy";
export { DROP_TEXT_MAX_BYTES, dropIntents, formatSize, isImageFile, isTextFile, type DropContext, type DropIntent, type DroppedItem } from "./drop";
export {
  EXPLAIN_CONTEXT_MAX_CHARS,
  EXPLAIN_MAX_OUTPUT_TOKENS,
  explainLocally,
  planModelExplanation,
  providerExplainActions,
  type ExplainAction,
  type ExplainContext,
  type ExplainSource,
  type Explanation,
  type ModelExplainPlan,
} from "./explain";
export {
  EMPTY_COMPANION_FACTS,
  currentActivity,
  focusMission,
  allPendingApprovals,
  reduceCompanionFacts,
  type CompanionFactsState,
  type MissionFacts,
} from "./facts";
export { baseName, formatClock, formatUsd, plural, shortCommand } from "./format";
export { FORBIDDEN_NOMI_PATTERNS, collectCopyStrings, findManipulation } from "./manipulation";
export {
  NOMI_COMMAND_IDS,
  NOMI_PALETTE_COMMANDS,
  QUIET_DURATION_MS,
  buildNomiMenu,
  type NomiCommandId,
  type NomiMenuAction,
  type NomiMenuEntry,
  type NomiMenuFacts,
  type NomiPaletteCommand,
} from "./menu";
export {
  NOTICE_JOURNAL_MAX,
  NOTIFICATION_COALESCE_MS,
  NotificationPolicy,
  describeNoticeGroup,
  isQuiet,
  type CompanionNotice,
  type NoticeDelivery,
  type NoticeInput,
  type NoticeKind,
  type NotificationContext,
  type SystemNotification,
} from "./notifications";
export {
  EVIDENCE_MAX_CHARS,
  approvalSummary,
  evidenceExcerpt,
  signalFromProcessExit,
  signalsFromMissionEvent,
  type ProducedSignal,
  type SignalDraft,
  type TerminalExit,
} from "./signals";
export { MAX_SUGGESTIONS, SUGGESTION_PRIORITY, rankSuggestions, suggestionForSignal, type SuggestionDraft } from "./suggestions";
export { parseTestCounts, summarizeProcessExit, type ProcessExitFact, type TestCounts, type WatchReport } from "./watch";

/** Proposed default (N2): one new suggestion pushed per 10 minutes at most (approvals excepted). */
export const DEFAULT_SUGGESTION_INTERVAL_MS = 10 * 60_000;
