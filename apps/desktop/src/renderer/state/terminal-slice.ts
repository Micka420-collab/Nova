// Terminal UI state: sessions mirrored from main (terminal.list / create / attach), the selected
// tab and the dock visibility. A standalone zustand store so the panel works before the lead merges
// it into the app store (the shape is slice-ready: state + actions, no dependency on AppState).
import { createStore, type StoreApi } from "zustand/vanilla";
import type { TerminalSession } from "@nova/shared";

export interface TerminalSliceState {
  sessions: TerminalSession[];
  activeId: string | null;
  /** Ctrl+J (`dock.toggle`). */
  dockOpen: boolean;
  status: "idle" | "loading" | "ready" | "error";
  /** Why the terminal is unavailable (message from main, secret-free), or null. */
  error: string | null;
}

export interface TerminalSliceActions {
  setSessions(sessions: TerminalSession[]): void;
  upsertSession(session: TerminalSession): void;
  markExited(sessionId: string, exitCode: number | null): void;
  removeSession(sessionId: string): void;
  select(sessionId: string | null): void;
  /** Toggles, or forces with `open`. */
  toggleDock(open?: boolean): void;
  setStatus(status: TerminalSliceState["status"], error?: string | null): void;
}

export type TerminalSlice = TerminalSliceState & TerminalSliceActions;
export type TerminalStore = StoreApi<TerminalSlice>;

export const initialTerminalState: TerminalSliceState = {
  sessions: [],
  activeId: null,
  dockOpen: false,
  status: "idle",
  error: null,
};

export function createTerminalStore(initial: Partial<TerminalSliceState> = {}): TerminalStore {
  return createStore<TerminalSlice>()((set) => ({
    ...initialTerminalState,
    ...initial,
    setSessions: (sessions) =>
      set((state) => ({
        sessions,
        activeId: sessions.some((s) => s.id === state.activeId) ? state.activeId : (sessions.at(-1)?.id ?? null),
      })),
    upsertSession: (session) =>
      set((state) => {
        const exists = state.sessions.some((s) => s.id === session.id);
        return {
          sessions: exists ? state.sessions.map((s) => (s.id === session.id ? session : s)) : [...state.sessions, session],
          activeId: state.activeId ?? session.id,
        };
      }),
    markExited: (sessionId, exitCode) =>
      set((state) => ({
        sessions: state.sessions.map((s) => (s.id === sessionId ? { ...s, state: "exited", exitCode } : s)),
      })),
    removeSession: (sessionId) =>
      set((state) => {
        const index = state.sessions.findIndex((s) => s.id === sessionId);
        const sessions = state.sessions.filter((s) => s.id !== sessionId);
        if (state.activeId !== sessionId) return { sessions };
        // Closing the selected tab selects its neighbor, like editor tabs.
        const next = sessions[Math.min(index, sessions.length - 1)] ?? null;
        return { sessions, activeId: next?.id ?? null };
      }),
    select: (activeId) => set({ activeId }),
    toggleDock: (open) => set((state) => ({ dockOpen: open ?? !state.dockOpen })),
    setStatus: (status, error = null) => set({ status, error }),
  }));
}
