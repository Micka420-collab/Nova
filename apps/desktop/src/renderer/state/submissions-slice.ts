// Sub-mission trees for the renderer (L5), mirrored from main (`submissions.tree`) and kept current
// by the mission events (`submission.started/updated` on the parent, terminal events of children).
// Standalone zustand store (slice-ready: state + actions, no dependency on AppState): the
// integrator may merge it into the app store. `availability` turns `unavailable` when main answers
// so: the UI then shows no control for the group.
import { createStore, type StoreApi } from "zustand/vanilla";
import {
  NovaIpcError,
  type IpcErrorCode,
  type MissionEvent,
  type MissionState,
  type MissionTreeNode,
  type NovaApi,
} from "@nova/shared";

export type SubmissionsClient = Pick<NovaApi, "submissions">;

export type SubmissionAction = "integrating" | "discarding";

export interface SubmissionActionError {
  action: "integrate" | "discard";
  /** null = not an IPC error (renderer bug): generic copy. */
  code: IpcErrorCode | null;
}

export interface SubmissionsSliceState {
  availability: "unknown" | "available" | "unavailable";
  /** Tree of each mission asked for (a parent with its children, or a child alone). */
  trees: Record<string, MissionTreeNode>;
  /** Missions whose tree is loading, and those whose last load failed. */
  loading: Record<string, true>;
  loadFailed: Record<string, true>;
  /** Action in flight per child (one at a time). */
  busy: Record<string, SubmissionAction>;
  /** Last failed action per child, cleared by the next attempt. */
  errors: Record<string, SubmissionActionError>;
}

export interface SubmissionsSliceActions {
  /** Reads the tree of a mission. Never throws: a failure is kept in `loadFailed`. */
  load(missionId: string): Promise<void>;
  /** Resolves with the new tree, or null when it failed (see `errors`). */
  integrate(childMissionId: string): Promise<MissionTreeNode | null>;
  discard(childMissionId: string): Promise<MissionTreeNode | null>;
  applyMissionEvent(event: MissionEvent): void;
}

export type SubmissionsSlice = SubmissionsSliceState & SubmissionsSliceActions;
export type SubmissionsStore = StoreApi<SubmissionsSlice>;

export const initialSubmissionsState: SubmissionsSliceState = {
  availability: "unknown",
  trees: {},
  loading: {},
  loadFailed: {},
  busy: {},
  errors: {},
};

function without<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record;
  const { [key]: _dropped, ...rest } = record;
  return rest;
}

const codeOf = (error: unknown): IpcErrorCode | null => (error instanceof NovaIpcError ? error.code : null);

/** Trees mentioning `missionId` as parent or child, with that mission's state replaced. */
function withMissionState(trees: Record<string, MissionTreeNode>, missionId: string, state: MissionState): Record<string, MissionTreeNode> {
  let changed = false;
  const next: Record<string, MissionTreeNode> = {};
  for (const [key, tree] of Object.entries(trees)) {
    const own = tree.mission.id === missionId && tree.mission.state !== state;
    const child = tree.children.some((item) => item.mission.id === missionId && item.mission.state !== state);
    if (!own && !child) {
      next[key] = tree;
      continue;
    }
    changed = true;
    next[key] = {
      ...tree,
      mission: own ? { ...tree.mission, state } : tree.mission,
      children: tree.children.map((item) => (item.mission.id === missionId ? { ...item, mission: { ...item.mission, state } } : item)),
    };
  }
  return changed ? next : trees;
}

/** Mission state after each lifecycle event (the tree shows children's live state). */
const STATE_BY_EVENT: Partial<Record<MissionEvent["type"], MissionState>> = {
  "mission.succeeded": "succeeded",
  "mission.failed": "failed",
  "mission.cancelled": "cancelled",
  "mission.started": "running",
  "mission.suspended": "suspended",
  "mission.resumed": "running",
};

export function createSubmissionsStore(client: SubmissionsClient): SubmissionsStore {
  return createStore<SubmissionsSlice>()((set, get) => {
    /** Records a tree (every tree it appears in is kept current by events). */
    const store = (tree: MissionTreeNode): void =>
      set((state) => ({ availability: "available", trees: { ...state.trees, [tree.mission.id]: tree } }));

    const act = async (childMissionId: string, action: SubmissionAction, call: () => Promise<MissionTreeNode>): Promise<MissionTreeNode | null> => {
      if (get().busy[childMissionId]) return null;
      set((state) => ({ busy: { ...state.busy, [childMissionId]: action }, errors: without(state.errors, childMissionId) }));
      try {
        const tree = await call();
        store(tree);
        return tree;
      } catch (error) {
        const code = codeOf(error);
        set((state) => ({
          availability: code === "unavailable" && state.availability === "unknown" ? "unavailable" : state.availability,
          errors: { ...state.errors, [childMissionId]: { action: action === "integrating" ? "integrate" : "discard", code } },
        }));
        // The state may have moved (tests_failed, pending): refresh what the user sees.
        const parent = Object.values(get().trees).find((tree) => tree.children.some((child) => child.mission.id === childMissionId));
        if (parent) void get().load(parent.mission.id);
        return null;
      } finally {
        set((state) => ({ busy: without(state.busy, childMissionId) }));
      }
    };

    return {
      ...initialSubmissionsState,

      async load(missionId) {
        set((state) => ({ loading: { ...state.loading, [missionId]: true } }));
        try {
          const tree = await client.submissions.tree({ missionId });
          set((state) => ({ loadFailed: without(state.loadFailed, missionId) }));
          store(tree);
        } catch (error) {
          const unavailable = codeOf(error) === "unavailable";
          set((state) => ({
            availability: unavailable ? "unavailable" : state.availability,
            loadFailed: unavailable ? state.loadFailed : { ...state.loadFailed, [missionId]: true },
          }));
        } finally {
          set((state) => ({ loading: without(state.loading, missionId) }));
        }
      },

      integrate: (childMissionId) => act(childMissionId, "integrating", () => client.submissions.integrate({ childMissionId })),
      discard: (childMissionId) => act(childMissionId, "discarding", () => client.submissions.discard({ childMissionId })),

      applyMissionEvent(event) {
        if (event.type === "submission.started") {
          // The child mission itself comes from main: reload the parent's tree when it is shown.
          if (get().trees[event.missionId] || get().availability === "available") void get().load(event.missionId);
          return;
        }
        if (event.type === "submission.updated") {
          const tree = get().trees[event.missionId];
          if (!tree) return;
          const known = tree.children.some((child) => child.link.childMissionId === event.link.childMissionId);
          if (!known) {
            void get().load(event.missionId);
            return;
          }
          const children = tree.children.map((child) =>
            child.link.childMissionId === event.link.childMissionId
              ? { mission: { ...child.mission, state: event.childState }, link: event.link }
              : child,
          );
          set((state) => ({ trees: { ...state.trees, [event.missionId]: { ...tree, children } } }));
          return;
        }
        const next = STATE_BY_EVENT[event.type];
        if (next) set((state) => ({ trees: withMissionState(state.trees, event.missionId, next) }));
      },
    };
  });
}

/** Children whose integration the user can start now. */
export function canIntegrate(child: MissionTreeNode["children"][number]): boolean {
  const { link, mission } = child;
  return mission.state === "succeeded" && link.worktree !== null && (link.integration === "pending" || link.integration === "tests_failed" || link.integration === "conflict");
}

/** Children the user can abandon now (running, or waiting for an integration decision). */
export function canDiscard(child: MissionTreeNode["children"][number]): boolean {
  const { link, mission } = child;
  if (link.integration === "integrated" || link.integration === "discarded" || link.integration === "testing") return false;
  if (link.integration === "not_needed") return mission.state !== "succeeded" && mission.state !== "failed" && mission.state !== "cancelled";
  return true;
}
