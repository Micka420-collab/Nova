// @nova/companion — Nomi's signal bus and suggestions (N1/N2/N3/N10/N11), runs in MAIN.
//
// Contract for the feature implementation:
// - Signals come only from recorded facts (tool results, process exits, mission events, approvals);
//   each is stored (`signals`) before any suggestion refers to it. No signal, no suggestion.
// - At most one visible suggestion; rate limit (proposed 1 per 10 min, never while typing); quiet
//   hours; muted kinds; nothing happens without a click; no network request to produce a signal.
// - N11 anti-manipulation: no guilt, streaks, scores, or attention-seeking notifications; copy is
//   tested for it.
import type { CompanionSignal, CompanionSignalKind, CompanionSuggestion } from "@nova/shared";

export interface SignalBus {
  /** Records a signal; returns it, or null when muted/deduplicated. */
  record(signal: Omit<CompanionSignal, "id" | "state" | "createdAt">): CompanionSignal | null;
  onSuggestion(listener: (suggestion: CompanionSuggestion) => void): () => void;
}

export interface SuggestionPolicy {
  /** Minimum delay between two proposed suggestions. */
  minIntervalMs: number;
  mutedKinds: ReadonlySet<CompanionSignalKind>;
}

/** Proposed default (N2): one suggestion per 10 minutes at most. */
export const DEFAULT_SUGGESTION_INTERVAL_MS = 10 * 60_000;
