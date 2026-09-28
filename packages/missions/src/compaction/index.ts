// L2 (C7/A15) — compaction, pruning and handoff dossier. Owned by lane L2.
// Main side: `createCompactionCore` backs the `context.*` IPC group (storage:
// compaction_summaries) and serves the loop's context hook (`runtimeHook`, wired as
// `MainRuntimeHandlers.context`): it applies APPLIED summaries and performs the handoff the user
// asked for before a model call, and measures usage after it. Never compacts silently.
export {
  CompactionError,
  createCompactionCore,
  type AppliedConversationHistory,
  type CompactionCore,
  type CompactionErrorCode,
  type CompactionPromptBuilder,
  type CompactionServiceDeps,
  type CompactionStoreLike,
  type NewSummaryInput,
  type SummarizeRequest,
  type SummarizeResult,
} from "./service";
export { buildHandoffDossier, recentContext, renderHandoff, DOSSIER_LIMITS, type DossierDraft, type DossierInput } from "./dossier";
export {
  approxTokens,
  conversationTranscript,
  missionTranscript,
  pruneText,
  transcriptFingerprint,
  type PruneLimits,
  type TranscriptEntry,
} from "./transcript";
