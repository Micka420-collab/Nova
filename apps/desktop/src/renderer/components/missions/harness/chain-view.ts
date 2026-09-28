// L4 — timeline projection of « Chaîne » programs (run_chain calls) of one mission.
// Owned by lane L4 (J2-B lane map). Pure: same events → same view.
//
// - The slice (`reduceChainEvent`) keeps each program and its outcome (chain.started/finished).
// - `nestChainCalls` places the calls a program made (tool items whose `parentCallId` is a
//   run_chain card of the list, and the approvals of those calls) under their parent card; a call
//   whose parent is not in the list (truncated log) stays at the top level, never hidden.
import type { ChainRunSummary, HarnessMissionEvent } from "@nova/shared";
import type { TimelineItem } from "../timeline";

export interface ChainRunView {
  callId: string;
  /** null when the log does not hold the program's start (truncated). */
  programPreview: string | null;
  startedAt: number | null;
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
    case "chain.finished": {
      const known = view.runs.some((run) => run.callId === event.summary.callId);
      if (!known) {
        return { runs: [...view.runs, { callId: event.summary.callId, programPreview: null, startedAt: null, summary: event.summary }] };
      }
      return { runs: view.runs.map((run) => (run.callId === event.summary.callId ? { ...run, summary: event.summary } : run)) };
    }
  }
}

/** The run of a run_chain card, or null (not a program, or its events are not in the log). */
export function chainRunOf(view: ChainView, callId: string): ChainRunView | null {
  return view.runs.find((run) => run.callId === callId) ?? null;
}

export interface NestedTimeline {
  /** Items shown at the top level, in their order. */
  items: TimelineItem[];
  /** Per run_chain call id: the calls of its program and their approvals, in their order. */
  children: ReadonlyMap<string, TimelineItem[]>;
}

export function nestChainCalls(items: readonly TimelineItem[]): NestedTimeline {
  const parents = new Set<string>();
  for (const item of items) if (item.kind === "tool" && item.call.name === "run_chain") parents.add(item.call.id);
  if (parents.size === 0) return { items: [...items], children: new Map() };

  const parentOf = new Map<string, string>();
  for (const item of items) {
    const parent = item.kind === "tool" ? item.call.parentCallId : null;
    if (item.kind === "tool" && parent && parents.has(parent)) parentOf.set(item.call.id, parent);
  }
  const top: TimelineItem[] = [];
  const children = new Map<string, TimelineItem[]>();
  for (const item of items) {
    const callId = item.kind === "tool" ? item.call.id : item.kind === "approval" ? item.approval.toolCallId : null;
    const parent = callId === null ? undefined : parentOf.get(callId);
    if (parent === undefined) {
      top.push(item);
      continue;
    }
    const list = children.get(parent);
    if (list) list.push(item);
    else children.set(parent, [item]);
  }
  return { items: top, children };
}
