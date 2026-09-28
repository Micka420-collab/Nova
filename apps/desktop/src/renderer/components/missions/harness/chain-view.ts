// L4 — timeline projection of « Chaîne » programs (run_chain calls) of one mission.
// Owned by lane L4 (J2-B lane map). Pure: same events → same view.
import type { ChainRunSummary, HarnessMissionEvent } from "@nova/shared";

export interface ChainRunView {
  callId: string;
  programPreview: string;
  startedAt: number;
  /** null while the program runs. */
  summary: ChainRunSummary | null;
}

export interface ChainView {
  runs: ChainRunView[];
}

export type ChainMissionEvent = Extract<HarnessMissionEvent, { type: "chain.started" | "chain.finished" }>;

export function initialChainView(): ChainView {
  return { runs: [] };
}

export function reduceChainEvent(view: ChainView, event: ChainMissionEvent): ChainView {
  switch (event.type) {
    case "chain.started":
      if (view.runs.some((run) => run.callId === event.callId)) return view;
      return { runs: [...view.runs, { callId: event.callId, programPreview: event.programPreview, startedAt: event.at, summary: null }] };
    case "chain.finished":
      return {
        runs: view.runs.map((run) => (run.callId === event.summary.callId ? { ...run, summary: event.summary } : run)),
      };
  }
}
