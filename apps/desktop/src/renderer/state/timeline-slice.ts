// L8 timeline state for the renderer: the search in the journal of the missions and the forks
// asked from an event (`timeline.*`). Standalone zustand store (slice-ready: state + actions, no
// dependency on AppState). `availability` turns `unavailable` when main answers so: the UI then
// shows no control for the group. Every action ends in a visible state (results, empty, error,
// ready mission).
import { createStore, type StoreApi } from "zustand/vanilla";
import { NovaIpcError, type MissionForkRequest, type MissionPlanResult, type NovaApi, type TimelineHit } from "@nova/shared";
import { toUiError, type UiError } from "../lib/errors";

export type TimelineClient = Pick<NovaApi, "timeline">;

export type TimelineScope = "mission" | "workspace" | "all";

/** Hits asked per search (the newest first); the UI says when the list is capped. */
export const TIMELINE_SEARCH_LIMIT = 50;

export interface TimelineSearchState {
  query: string;
  scope: TimelineScope;
  status: "idle" | "searching" | "done" | "error";
  hits: TimelineHit[];
  error: UiError | null;
}

export type ForkState =
  | { status: "preparing" }
  | { status: "ready"; result: MissionPlanResult }
  | { status: "error"; error: UiError };

export interface TimelineSliceState {
  /** `unknown` until main answered once; `unavailable` = the group is not wired: show nothing. */
  availability: "unknown" | "available" | "unavailable";
  search: TimelineSearchState;
  /** Per event (`forkKey`): the fork asked from it. */
  forks: Record<string, ForkState>;
}

export interface TimelineSearchInput {
  query: string;
  scope: TimelineScope;
  workspaceId: string | null;
  missionId: string | null;
}

export interface TimelineSliceActions {
  /**
   * Learns once whether main serves the group (a one-hit read, no effect), so the UI never shows
   * a control main would refuse. Never throws.
   */
  probe(): Promise<void>;
  /** Never throws: the outcome is in `search` (stale answers of an older query are dropped). */
  runSearch(input: TimelineSearchInput): Promise<void>;
  setScope(scope: TimelineScope): void;
  /** Resolves with the new mission (also kept in `forks`); null on failure (see `forks`). */
  fork(request: MissionForkRequest): Promise<MissionPlanResult | null>;
  dismissFork(missionId: string, seq: number): void;
}

export type TimelineSlice = TimelineSliceState & TimelineSliceActions;
export type TimelineStore = StoreApi<TimelineSlice>;

export function forkKey(missionId: string, seq: number): string {
  return `${missionId}:${seq}`;
}

const INITIAL_SEARCH: TimelineSearchState = { query: "", scope: "mission", status: "idle", hits: [], error: null };

const isUnavailable = (error: unknown): boolean => error instanceof NovaIpcError && error.code === "unavailable";

/** The scope actually searched: a mission scope without a mission widens to the project, then to all. */
export function effectiveScope(input: Pick<TimelineSearchInput, "scope" | "workspaceId" | "missionId">): TimelineScope {
  if (input.scope === "mission" && input.missionId) return "mission";
  if (input.scope !== "all" && input.workspaceId) return "workspace";
  return "all";
}

export function createTimelineStore(client: TimelineClient): TimelineStore {
  let latest = 0;
  let probing: Promise<void> | null = null;
  return createStore<TimelineSlice>()((set, get) => ({
    availability: "unknown",
    search: INITIAL_SEARCH,
    forks: {},

    probe() {
      if (get().availability !== "unknown") return Promise.resolve();
      probing ??= client.timeline
        .search({ query: "nova", workspaceId: null, missionId: null, limit: 1 })
        .then(
          () => set({ availability: "available" }),
          // Any other refusal still proves the group is served: its actions report their own errors.
          (error: unknown) => set({ availability: isUnavailable(error) ? "unavailable" : "available" }),
        )
        .finally(() => {
          probing = null;
        });
      return probing;
    },

    setScope(scope) {
      set((state) => ({ search: { ...state.search, scope } }));
    },

    async runSearch(input) {
      const query = input.query.trim();
      const request = ++latest;
      if (!query) {
        set((state) => ({ search: { ...state.search, query: "", status: "idle", hits: [], error: null } }));
        return;
      }
      const scope = effectiveScope(input);
      set((state) => ({ search: { ...state.search, query, scope: input.scope, status: "searching", error: null } }));
      try {
        const hits = await client.timeline.search({
          query: query.slice(0, 200),
          workspaceId: scope === "all" ? null : input.workspaceId,
          missionId: scope === "mission" ? input.missionId : null,
          limit: TIMELINE_SEARCH_LIMIT,
        });
        if (request !== latest) return;
        set((state) => ({ availability: "available", search: { ...state.search, status: "done", hits, error: null } }));
      } catch (error) {
        if (request !== latest) return;
        if (isUnavailable(error)) set({ availability: "unavailable" });
        set((state) => ({ search: { ...state.search, status: "error", hits: [], error: toUiError(error) } }));
      }
    },

    async fork(request) {
      const key = forkKey(request.missionId, request.atSeq);
      if (get().forks[key]?.status === "preparing") return null;
      set((state) => ({ forks: { ...state.forks, [key]: { status: "preparing" } } }));
      try {
        const result = await client.timeline.fork(request);
        set((state) => ({ availability: "available", forks: { ...state.forks, [key]: { status: "ready", result } } }));
        return result;
      } catch (error) {
        if (isUnavailable(error)) set({ availability: "unavailable" });
        set((state) => ({ forks: { ...state.forks, [key]: { status: "error", error: toUiError(error) } } }));
        return null;
      }
    },

    dismissFork(missionId, seq) {
      const key = forkKey(missionId, seq);
      set((state) => {
        const { [key]: _removed, ...rest } = state.forks;
        return { forks: rest };
      });
    },
  }));
}
