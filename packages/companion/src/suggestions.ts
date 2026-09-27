// P6 deterministic suggestion rules (NOMI.md §3): each suggestion is justified by ONE recorded
// signal (its id travels with it), at most three are ranked, in the table's order. No model call.
import type { CompanionAction, CompanionSignal, CompanionSignalKind, ProviderErrorCode } from "@nova/shared";
import { NOMI_COPY } from "./copy";
import type { CompanionFactsState, MissionFacts } from "./facts";
import { shortCommand } from "./format";
import { parseTestCounts } from "./watch";

/** Rule order of the P6 table: what blocks work first, then what failed, then what finished. */
export const SUGGESTION_PRIORITY: readonly CompanionSignalKind[] = [
  "approval_pending",
  "budget_reached",
  "test_failed",
  "process_crashed",
  "mission_failed",
  "mission_done",
  "mission_waiting",
];

export const MAX_SUGGESTIONS = 3;

export interface SuggestionDraft {
  signalId: string;
  kind: CompanionSignalKind;
  text: string;
  action: CompanionAction;
}

function missionOf(signal: CompanionSignal, facts: CompanionFactsState): MissionFacts | null {
  const ref = signal.sourceRef;
  const missionId = ref.kind === "terminal" ? null : ref.missionId;
  return missionId ? (facts.missions[missionId] ?? null) : null;
}

/** A signal whose fact is known to be over (approval answered, failure fixed…) proposes nothing. */
function stillRelevant(signal: CompanionSignal, mission: MissionFacts | null): boolean {
  if (!mission) return true;
  const ref = signal.sourceRef;
  switch (signal.kind) {
    case "approval_pending":
      return ref.kind === "approval" && mission.pendingApprovals.some((approval) => approval.id === ref.approvalId);
    case "budget_reached":
    case "mission_waiting":
      return mission.state === "suspended";
    case "test_failed":
    case "process_crashed":
      return ref.kind !== "tool_call" || mission.unresolvedFailure !== null;
    case "mission_done":
    case "mission_failed":
      return true;
  }
}

function commandRun(mission: MissionFacts | null, signal: CompanionSignal) {
  const ref = signal.sourceRef;
  if (ref.kind !== "tool_call" || !mission) return null;
  return mission.commands.find((command) => command.callId === ref.toolCallId) ?? null;
}

/** Text and action of one signal, or null when the rule does not apply. */
export function suggestionForSignal(signal: CompanionSignal, mission: MissionFacts | null): SuggestionDraft | null {
  if (signal.state === "ignored" || !stillRelevant(signal, mission)) return null;
  const ref = signal.sourceRef;
  const title = mission?.title ?? null;
  const excerpt = signal.evidence.excerpt;
  const base = { signalId: signal.id, kind: signal.kind };
  switch (signal.kind) {
    case "approval_pending":
      if (ref.kind !== "approval") return null;
      return {
        ...base,
        text: NOMI_COPY.suggestion.approval(excerpt ?? NOMI_COPY.explain.unknown),
        action: { type: "open_approval", approvalId: ref.approvalId },
      };
    case "budget_reached":
      if (ref.kind !== "mission") return null;
      return {
        ...base,
        text: NOMI_COPY.suggestion.budget(title, mission?.budget?.spentUsd ?? null, mission?.budget?.budgetUsd ?? null),
        action: { type: "stop_mission", missionId: ref.missionId },
      };
    case "test_failed": {
      const counts = excerpt ? parseTestCounts(excerpt) : null;
      const what = counts?.firstFailure ?? "Un test";
      return { ...base, text: NOMI_COPY.suggestion.testFailed(what, signal.createdAt), action: { type: "explain_error", sourceRef: ref } };
    }
    case "process_crashed": {
      const run = commandRun(mission, signal);
      // A terminal signal carries no argv: "La commande surveillée s'est arrêtée."
      const label = run ? shortCommand(run.argv) : "surveillée";
      return {
        ...base,
        text: NOMI_COPY.suggestion.processCrashed(label, run?.exitCode ?? null),
        action: { type: "explain_error", sourceRef: ref },
      };
    }
    case "mission_failed":
      if (ref.kind !== "mission") return null;
      return {
        ...base,
        text: NOMI_COPY.suggestion.missionFailed(title, excerpt ?? NOMI_COPY.explain.unknown),
        action: { type: "explain_error", sourceRef: ref },
      };
    case "mission_done":
      if (ref.kind !== "mission") return null;
      return {
        ...base,
        text: NOMI_COPY.suggestion.missionDone(title, mission?.files.length ?? 0),
        action: { type: "show_changes", missionId: ref.missionId },
      };
    case "mission_waiting":
      if (ref.kind !== "mission") return null;
      return {
        ...base,
        text: NOMI_COPY.suggestion.missionWaiting(title, excerpt ?? NOMI_COPY.explain.unknown),
        action: { type: "show_changes", missionId: ref.missionId },
      };
  }
}

/**
 * Ranked suggestions (≤ `max`, default 3): muted kinds and ignored signals excluded, one per
 * signal, P6 order then newest first. Deterministic for a given input.
 */
export function rankSuggestions(
  signals: readonly CompanionSignal[],
  facts: CompanionFactsState,
  mutedKinds: ReadonlySet<CompanionSignalKind>,
  max = MAX_SUGGESTIONS,
): SuggestionDraft[] {
  const drafts: { draft: SuggestionDraft; createdAt: number }[] = [];
  for (const signal of signals) {
    if (mutedKinds.has(signal.kind)) continue;
    const draft = suggestionForSignal(signal, missionOf(signal, facts));
    if (draft) drafts.push({ draft, createdAt: signal.createdAt });
  }
  drafts.sort(
    (a, b) =>
      SUGGESTION_PRIORITY.indexOf(a.draft.kind) - SUGGESTION_PRIORITY.indexOf(b.draft.kind) ||
      b.createdAt - a.createdAt ||
      a.draft.signalId.localeCompare(b.draft.signalId),
  );
  return drafts.slice(0, max).map(({ draft }) => draft);
}

/**
 * P6 rows backed by live chat facts of the renderer (J1): no key, the last answer failed in a way
 * that can be retried, an answer cut at its maximum length. They are not recorded signals (the
 * `signals` kinds are atelier facts), so each carries the identity of its fact instead (`factId`),
 * and they rank after every recorded signal. At most two actions, as any bubble.
 */
export interface ChatFacts {
  /** `connection.state === "absent"`; null while the connection has not been read. */
  keyAbsent: boolean | null;
  /** Last failed answer, only when its conversation is not the one on screen (it shows its own error). */
  lastFailure: { conversationId: string; at: number; code: ProviderErrorCode; retryable: boolean } | null;
}

export type FactAction =
  | { type: "open_provider_settings" }
  /** Opens the conversation, where the failed answer shows its « Réessayer » button. */
  | { type: "open_conversation"; conversationId: string }
  | { type: "choose_model"; conversationId: string };

export interface FactSuggestion {
  /** Identity of the fact (dismissing it hides this fact only, not the next one). */
  factId: string;
  text: string;
  actions: { label: string; action: FactAction }[];
}

export function chatFactSuggestions(facts: ChatFacts): FactSuggestion[] {
  const copy = NOMI_COPY.suggestion;
  const out: FactSuggestion[] = [];
  if (facts.keyAbsent === true) {
    out.push({
      factId: "connection:absent",
      text: copy.connectionAbsent,
      actions: [{ label: copy.addKey, action: { type: "open_provider_settings" } }],
    });
  }
  const failure = facts.lastFailure;
  if (failure) {
    const factId = `chat:${failure.conversationId}:${failure.at}`;
    const { conversationId } = failure;
    if (failure.code === "truncated") {
      out.push({
        factId,
        text: copy.chatTruncated,
        actions: [
          { label: copy.openConversation, action: { type: "open_conversation", conversationId } },
          { label: copy.otherModel, action: { type: "choose_model", conversationId } },
        ],
      });
    } else if (failure.retryable) {
      out.push({
        factId,
        text: copy.chatFailed(NOMI_COPY.chatFailure[failure.code]),
        actions: [{ label: copy.openConversation, action: { type: "open_conversation", conversationId } }],
      });
    }
  }
  return out.slice(0, MAX_SUGGESTIONS);
}
