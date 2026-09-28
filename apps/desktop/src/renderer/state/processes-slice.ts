// Background processes of missions (L1): records mirrored from main (`processes.list` + the
// `processes.onEvent` push). A standalone zustand store, slice-ready like the terminal slice: the
// integrator can merge it into the app store (state + actions, no dependency on AppState).
import { createStore, type StoreApi } from "zustand/vanilla";
import type { MissionProcess, ProcessEvent } from "@nova/shared";
import { mergeProcess } from "../components/missions/harness/processes-view";

export interface ProcessesSliceState {
  /** Every known process, oldest start first. */
  processes: MissionProcess[];
  /** `unavailable`: main answers so (group not wired): the UI shows no control for it. */
  status: "idle" | "loading" | "ready" | "unavailable" | "error";
  /** Processes whose stop is in flight. */
  stopping: Record<string, true>;
}

export interface ProcessesSliceActions {
  /** Replaces the records a `processes.list` with the same scope answers for (null = any). */
  setProcesses(scope: ProcessesScope, processes: MissionProcess[]): void;
  applyEvent(event: ProcessEvent): void;
  upsert(process: MissionProcess): void;
  setStatus(status: ProcessesSliceState["status"]): void;
  setStopping(processId: string, stopping: boolean): void;
}

export interface ProcessesScope {
  workspaceId: string | null;
  missionId: string | null;
}

export type ProcessesSlice = ProcessesSliceState & ProcessesSliceActions;

function inScope(process: MissionProcess, scope: ProcessesScope): boolean {
  return (scope.workspaceId === null || process.workspaceId === scope.workspaceId) && (scope.missionId === null || process.missionId === scope.missionId);
}
export type ProcessesStore = StoreApi<ProcessesSlice>;

export const initialProcessesState: ProcessesSliceState = { processes: [], status: "idle", stopping: {} };

function sorted(processes: MissionProcess[]): MissionProcess[] {
  return [...processes].sort((a, b) => a.startedAt - b.startedAt);
}

function upserted(processes: MissionProcess[], process: MissionProcess): MissionProcess[] {
  const known = processes.find((item) => item.id === process.id);
  if (!known) return sorted([...processes, process]);
  return processes.map((item) => (item.id === process.id ? mergeProcess(item, process) : item));
}

export function createProcessesStore(initial: Partial<ProcessesSliceState> = {}): ProcessesStore {
  return createStore<ProcessesSlice>()((set) => ({
    ...initialProcessesState,
    ...initial,
    setProcesses: (scope, processes) =>
      set((state) => ({
        processes: sorted([...state.processes.filter((item) => !inScope(item, scope)), ...processes.filter((item) => inScope(item, scope))]),
      })),
    applyEvent: (event) => set((state) => ({ processes: upserted(state.processes, event.process) })),
    upsert: (process) => set((state) => ({ processes: upserted(state.processes, process) })),
    setStatus: (status) => set({ status }),
    setStopping: (processId, stopping) =>
      set((state) => {
        const { [processId]: _dropped, ...rest } = state.stopping;
        return { stopping: stopping ? { ...rest, [processId]: true } : rest };
      }),
  }));
}

export function missionProcesses(processes: readonly MissionProcess[], missionId: string): MissionProcess[] {
  return processes.filter((item) => item.missionId === missionId);
}

/**
 * Agent terminal sessions that host a RUNNING program ("Prendre la main" makes sense there). Other
 * agent sessions mirror structured commands and take no input (TerminalPanel `canTakeOver`).
 */
export function interactiveAgentSessions(processes: readonly MissionProcess[]): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const item of processes) if (item.state === "running" && item.terminalSessionId !== null) ids.add(item.terminalSessionId);
  return ids;
}
