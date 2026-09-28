// L2 — timeline projection of context usage, compactions and handoffs of one mission.
// Owned by lane L2 (J2-B lane map). Pure: same events → same view.
import type { CompactionSummary, ContextUsage, HandoffDossier, HarnessMissionEvent } from "@nova/shared";

export interface ContextView {
  /** Last measured usage (live only: absent after a reload until the next model call). */
  usage: ContextUsage | null;
  /** Every summary of the mission, by id, oldest first (proposed, applied or dismissed). */
  summaries: CompactionSummary[];
  handoffs: HandoffDossier[];
  modelSwitches: { at: number; fromModelId: string | null; toModelId: string; handoffSummaryId: string | null }[];
}

export type ContextMissionEvent = Extract<
  HarnessMissionEvent,
  {
    type:
      | "context.usage"
      | "compaction.proposed"
      | "compaction.applied"
      | "compaction.dismissed"
      | "handoff.created"
      | "model.switched";
  }
>;

export function initialContextView(): ContextView {
  return { usage: null, summaries: [], handoffs: [], modelSwitches: [] };
}

function upsert(summaries: CompactionSummary[], summary: CompactionSummary): CompactionSummary[] {
  const index = summaries.findIndex((item) => item.id === summary.id);
  if (index === -1) return [...summaries, summary];
  return summaries.map((item, at) => (at === index ? summary : item));
}

export function reduceContextEvent(view: ContextView, event: ContextMissionEvent): ContextView {
  switch (event.type) {
    case "context.usage":
      return { ...view, usage: event.usage };
    case "compaction.proposed":
    case "compaction.applied":
      return { ...view, summaries: upsert(view.summaries, event.summary) };
    case "compaction.dismissed":
      return {
        ...view,
        summaries: view.summaries.map((item) =>
          item.id === event.summaryId ? { ...item, status: "dismissed", decidedAt: event.at } : item,
        ),
      };
    case "handoff.created":
      return { ...view, handoffs: [...view.handoffs, event.dossier] };
    case "model.switched":
      return {
        ...view,
        modelSwitches: [
          ...view.modelSwitches,
          { at: event.at, fromModelId: event.fromModelId, toModelId: event.toModelId, handoffSummaryId: event.handoffSummaryId },
        ],
      };
  }
}
