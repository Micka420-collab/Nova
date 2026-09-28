// L2 — context of the open conversation (Discuter): gauge, the summary waiting for a decision and
// the one in use. `/compact` in the composer goes through `useCompactAction`. Nothing is shown
// while main says the `context` group is unavailable.
import { useCallback, useEffect } from "react";
import { useToast } from "@nova/ui";
import type { CompactionSummary, ContextTarget } from "@nova/shared";
import { contextCopy } from "../../copy/fr-context";
import { errorToast } from "../../lib/errors";
import { EMPTY_TARGET, contextTargetKey, pendingSummary } from "../../state/context-slice";
import { ContextGauge } from "./ContextGauge";
import { SummaryCard } from "./SummaryCard";
import { useContextSlice, useContextStore } from "./use-context-store";

/**
 * Asks main for a summary proposal of a conversation (`/compact [consigne]`). Resolves true once
 * the proposal exists (its card then waits for Appliquer / Écarter); on failure, shows why and
 * resolves false.
 */
export function useCompactAction(): (conversationId: string, modelId: string, instructions: string | null) => Promise<boolean> {
  const store = useContextStore();
  const toast = useToast();
  return useCallback(
    async (conversationId, modelId, instructions) => {
      try {
        await store.getState().compact({ kind: "conversation", conversationId }, modelId, instructions);
        toast.show({ title: contextCopy.conversation.proposalReady, tone: "info" });
        return true;
      } catch (error) {
        toast.show(errorToast(error, contextCopy.summary.compactFailed));
        return false;
      }
    },
    [store, toast],
  );
}

/** The summary to show for a conversation: the one waiting for a decision, else the latest applied. */
export function visibleConversationSummary(summaries: readonly CompactionSummary[]): CompactionSummary | null {
  return summaries.findLast((summary) => summary.status === "proposed") ?? summaries.findLast((summary) => summary.status === "applied") ?? null;
}

export interface ConversationContextPanelProps {
  conversationId: string;
  /** Model of the next message (writes the summary); null = none chosen, no summary offered. */
  modelId: string | null;
}

/** Usage refreshes by push: main's `observeConversation` (after each answer) emits `context.usage`. */
export function ConversationContextPanel({ conversationId, modelId }: ConversationContextPanelProps) {
  const store = useContextStore();
  const toast = useToast();
  const compactAction = useCompactAction();
  const target: ContextTarget = { kind: "conversation", conversationId };
  const key = contextTargetKey(target);
  const availability = useContextSlice((state) => state.availability);
  const context = useContextSlice((state) => state.targets[key] ?? EMPTY_TARGET);

  useEffect(() => {
    void store.getState().load({ kind: "conversation", conversationId });
  }, [store, conversationId]);

  if (availability !== "available") return null;
  const shown = visibleConversationSummary(context.summaries);
  const pending = pendingSummary(context);
  const decide = (summary: CompactionSummary, decision: "apply" | "dismiss") =>
    void store
      .getState()
      .decide(summary, decision)
      .then(
        () => store.getState().load({ kind: "conversation", conversationId }),
        (error: unknown) =>
          toast.show(errorToast(error, decision === "apply" ? contextCopy.summary.applyFailed : contextCopy.summary.dismissFailed)),
      );
  const compact = modelId && !pending ? () => void compactAction(conversationId, modelId, null) : undefined;

  return (
    <section className="nova-context" aria-label={contextCopy.conversation.heading}>
      <ContextGauge usage={context.usage} {...(compact ? { onCompact: compact } : {})} compacting={context.busy === "compacting"} />
      {shown ? (
        <SummaryCard
          summary={shown}
          busy={context.busy === "deciding"}
          onApply={() => decide(shown, "apply")}
          onDismiss={() => decide(shown, "dismiss")}
        />
      ) : null}
    </section>
  );
}
