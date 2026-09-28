// L2 (C7/A15) — compaction, pruning and handoff dossier. Owned by lane L2.
// Main side: `CompactionService` backs the `context.*` IPC group (storage: compaction_summaries).
// Runtime side: a `LoopContextHook` (../loop) applies APPLIED summaries and prunes big tool
// results before each model call, and reports usage after it. Never compacts silently.
import type {
  CompactRequest,
  CompactionDecideRequest,
  CompactionSummary,
  ContextEvent,
  ContextTarget,
  ContextUsage,
  HandoffDossier,
  HandoffRequest,
} from "@nova/shared";

export interface CompactionService {
  usage(target: ContextTarget): Promise<ContextUsage>;
  /** Writes a summary in `proposed` state (manual /compact or the automatic proposal). */
  compact(request: CompactRequest): Promise<CompactionSummary>;
  decide(request: CompactionDecideRequest): Promise<CompactionSummary>;
  list(target: ContextTarget): Promise<CompactionSummary[]>;
  handoff(request: HandoffRequest): Promise<HandoffDossier>;
  onEvent(listener: (event: ContextEvent) => void): () => void;
}
