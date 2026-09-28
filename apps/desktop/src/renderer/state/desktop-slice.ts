// L7 desktop state for the renderer, mirrored from main (`desktop.state` + `desktop.onEvent`), and
// whether the L7 groups are wired. Standalone zustand store, one per client (see `desktopStoreFor`),
// so the L7 components work wherever they are mounted without wiring in the app store.
// `availability` turns `unavailable` when main answers so: the UI then shows no L7 control
// (background option, autopilot) instead of a control that cannot work.
import { createStore, type StoreApi } from "zustand/vanilla";
import { useStore } from "zustand";
import { NovaIpcError, type DesktopEvent, type DesktopState, type NovaApi } from "@nova/shared";
import { useClient } from "./context";

export type DesktopClient = Pick<NovaApi, "desktop" | "autopilot">;

export interface DesktopSliceState {
  /** `unknown` until main answered once; `unavailable` = the L7 groups are not wired. */
  availability: "unknown" | "available" | "unavailable";
  state: DesktopState | null;
  /** `autopilot.classify` answered `unavailable` once: the autopilot is hidden for this session. */
  autopilotUnavailable: boolean;
}

export interface DesktopSliceActions {
  /** Reads the state once and follows its events; returns the unsubscribe function. Never throws. */
  start(): () => void;
  applyEvent(event: DesktopEvent): void;
  markAutopilotUnavailable(): void;
}

export type DesktopSlice = DesktopSliceState & DesktopSliceActions;
export type DesktopStore = StoreApi<DesktopSlice>;

export const isUnavailableError = (error: unknown): boolean => error instanceof NovaIpcError && error.code === "unavailable";

export function createDesktopStore(client: DesktopClient): DesktopStore {
  return createStore<DesktopSlice>()((set) => ({
    availability: "unknown",
    state: null,
    autopilotUnavailable: false,
    start() {
      let active = true;
      const unsubscribe = client.desktop.onEvent((event) => {
        if (active) set({ availability: "available", state: event.state });
      });
      client.desktop.state().then(
        (state) => {
          // An event may have arrived meanwhile: it is newer than this answer.
          if (active) set((current) => ({ availability: "available", state: current.state ?? state }));
        },
        (error: unknown) => {
          if (active) set({ availability: isUnavailableError(error) ? "unavailable" : "unknown" });
        },
      );
      return () => {
        active = false;
        unsubscribe();
      };
    },
    applyEvent(event) {
      set({ availability: "available", state: event.state });
    },
    markAutopilotUnavailable() {
      set({ autopilotUnavailable: true });
    },
  }));
}

const stores = new WeakMap<DesktopClient, DesktopStore>();

/** One store per client, following main for the app's lifetime (started on first use). */
export function desktopStoreFor(client: DesktopClient): DesktopStore {
  let store = stores.get(client);
  if (!store) {
    store = createDesktopStore(client);
    store.getState().start();
    stores.set(client, store);
  }
  return store;
}

export function useDesktopSlice<T>(selector: (state: DesktopSlice) => T): T {
  return useStore(desktopStoreFor(useClient()), selector);
}
