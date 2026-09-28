// L2 — context of one mission in its card / the agent panel: gauge, proposed and decided
// summaries, handoff dossiers, « Changer de modèle ». Facts come from the mission's journal
// (MissionView.harness.context) merged with main's answers; nothing is shown while main says the
// `context` group is unavailable.
import { useEffect } from "react";
import { useToast } from "@nova/ui";
import type { CompactionSummary, ContextTarget, MissionState } from "@nova/shared";
import { contextCopy } from "../../copy/fr-context";
import { errorToast } from "../../lib/errors";
import { useApp } from "../../state/context";
import { EMPTY_TARGET, contextTargetKey } from "../../state/context-slice";
import type { MissionView } from "../missions/timeline";
import { ContextGauge } from "./ContextGauge";
import { HandoffCard } from "./HandoffCard";
import { ModelSwitcher } from "./ModelSwitcher";
import { SummaryCard } from "./SummaryCard";
import { useContextSlice, useContextStore } from "./use-context-store";

/** States in which the mission runs in the runtime (main accepts compaction and handoff). */
const LIVE_STATES: readonly MissionState[] = ["running", "waiting_approval", "suspended"];

/** Journal and main may both know a summary: a decided copy wins over a proposed one. */
export function mergeSummaries(fromJournal: readonly CompactionSummary[], fromMain: readonly CompactionSummary[]): CompactionSummary[] {
  const byId = new Map<string, CompactionSummary>();
  for (const summary of [...fromJournal, ...fromMain]) {
    const known = byId.get(summary.id);
    if (!known || (known.status === "proposed" && summary.status !== "proposed")) byId.set(summary.id, summary);
  }
  return [...byId.values()].filter((summary) => summary.kind === "compaction").sort((a, b) => a.createdAt - b.createdAt);
}

export function MissionContextPanel({ view }: { view: MissionView }) {
  const store = useContextStore();
  const toast = useToast();
  const missionId = view.mission.id;
  const target: ContextTarget = { kind: "mission", missionId };
  const key = contextTargetKey(target);
  const availability = useContextSlice((state) => state.availability);
  const fromMain = useContextSlice((state) => state.targets[key] ?? EMPTY_TARGET);
  const models = useApp((state) => state.catalog.data?.models);

  useEffect(() => {
    void store.getState().load({ kind: "mission", missionId });
  }, [store, missionId]);

  if (availability !== "available") return null;
  const journal = view.harness.context;
  const live = LIVE_STATES.includes(view.mission.state);
  const usage = journal.usage ?? fromMain.usage;
  const summaries = mergeSummaries(journal.summaries, fromMain.summaries);
  const modelId = view.mission.modelId;

  const act = (work: () => Promise<unknown>, failure: string): Promise<void> =>
    work().then(
      () => undefined,
      (error: unknown) => {
        toast.show(errorToast(error, failure));
        throw error;
      },
    );
  const decide = (summary: CompactionSummary, decision: "apply" | "dismiss") =>
    void act(() => store.getState().decide(summary, decision), decision === "apply" ? contextCopy.summary.applyFailed : contextCopy.summary.dismissFailed).catch(() => undefined);
  const compact =
    live && modelId
      ? () => void act(() => store.getState().compact(target, modelId, null), contextCopy.summary.compactFailed).catch(() => undefined)
      : undefined;
  const switchModel = async (toModelId: string): Promise<void> => {
    await act(() => store.getState().handoff(missionId, toModelId), contextCopy.switcher.failed);
    toast.show({ title: contextCopy.switcher.done(toModelId), tone: "success" });
  };

  return (
    <section className="nova-context" aria-label={contextCopy.gauge.label}>
      <ContextGauge usage={usage} {...(compact ? { onCompact: compact } : {})} compacting={fromMain.busy === "compacting"} />
      {summaries.map((summary) => (
        <SummaryCard
          key={summary.id}
          summary={summary}
          busy={fromMain.busy === "deciding"}
          expired={!live}
          {...(live ? { onApply: () => decide(summary, "apply"), onDismiss: () => decide(summary, "dismiss") } : {})}
        />
      ))}
      {journal.handoffs.map((dossier) => (
        <HandoffCard
          key={dossier.summaryId}
          dossier={dossier}
          switched={journal.modelSwitches.some((item) => item.handoffSummaryId === dossier.summaryId)}
        />
      ))}
      {live ? <ModelSwitcher models={models ?? null} currentModelId={modelId} onSwitch={switchModel} busy={fromMain.busy === "switching"} /> : null}
    </section>
  );
}
