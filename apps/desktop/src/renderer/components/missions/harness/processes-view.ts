// L1 — timeline projection of the agent terminal and background processes of one mission.
// Owned by lane L1 (J2-B lane map). Pure: same events → same view.
import type { HarnessMissionEvent, MissionProcess } from "@nova/shared";

export interface ProcessesView {
  /** Latest known state of each background process, by id, in start order. */
  processes: MissionProcess[];
  /** Agent terminal session mirroring each tool call (callId → sessionId). */
  terminals: Record<string, string>;
}

export type ProcessesEvent = Extract<HarnessMissionEvent, { type: "tool.terminal" | "process.started" | "process.ended" }>;

export function initialProcessesView(): ProcessesView {
  return { processes: [], terminals: {} };
}

function upsert(processes: MissionProcess[], process: MissionProcess): MissionProcess[] {
  const index = processes.findIndex((item) => item.id === process.id);
  if (index === -1) return [...processes, process];
  return processes.map((item, at) => (at === index ? process : item));
}

export function reduceProcessesEvent(view: ProcessesView, event: ProcessesEvent): ProcessesView {
  switch (event.type) {
    case "tool.terminal":
      return { ...view, terminals: { ...view.terminals, [event.callId]: event.sessionId } };
    case "process.started":
    case "process.ended":
      return { ...view, processes: upsert(view.processes, event.process) };
  }
}
