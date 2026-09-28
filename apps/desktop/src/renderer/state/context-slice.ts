// L2 context state for the renderer: usage and summaries per target, mirrored from main
// (`context.*` + `context.onEvent`). Standalone zustand store (slice-ready: state + actions, no
// dependency on AppState). `availability` turns `unavailable` when main answers so: the UI then
// shows no control for the group. Mission summaries also arrive as mission events (MissionView);
// this store is what conversations and the actions use.
import { createStore, type StoreApi } from "zustand/vanilla";
import {
  NovaIpcError,
  type CompactionSummary,
  type ContextEvent,
  type ContextTarget,
  type ContextUsage,
  type HandoffDossier,
  type NovaApi,
} from "@nova/shared";

export type ContextClient = Pick<NovaApi, "context">;

export interface TargetContext {
  usage: ContextUsage | null;
  /** Oldest first. */
  summaries: CompactionSummary[];
  /** What is running for this target right now (one action at a time per target). */
  busy: "loading" | "compacting" | "deciding" | "switching" | null;
}

export interface ContextSliceState {
  /** `unknown` until main answered once; `unavailable` = the group is not wired: show nothing. */
  availability: "unknown" | "available" | "unavailable";
  targets: Record<string, TargetContext>;
}

export interface ContextSliceActions {
  /** Reads usage + summaries of a target. Never throws: a failure leaves the target as it was. */
  load(target: ContextTarget): Promise<void>;
  /** `/compact` or « Résumer maintenant »: resolves with the proposal; throws the IPC error. */
  compact(target: ContextTarget, modelId: string, instructions: string | null): Promise<CompactionSummary>;
  decide(summary: CompactionSummary, decision: "apply" | "dismiss"): Promise<CompactionSummary>;
  handoff(missionId: string, toModelId: string): Promise<HandoffDossier>;
  applyEvent(event: ContextEvent): void;
}

export type ContextSlice = ContextSliceState & ContextSliceActions;
export type ContextStore = StoreApi<ContextSlice>;

export function contextTargetKey(target: ContextTarget): string {
  return target.kind === "mission" ? `mission:${target.missionId}` : `conversation:${target.conversationId}`;
}

export const EMPTY_TARGET: TargetContext = { usage: null, summaries: [], busy: null };

function upsert(summaries: CompactionSummary[], summary: CompactionSummary): CompactionSummary[] {
  const index = summaries.findIndex((item) => item.id === summary.id);
  if (index === -1) return [...summaries, summary].sort((a, b) => a.createdAt - b.createdAt);
  return summaries.map((item, at) => (at === index ? summary : item));
}

const isUnavailable = (error: unknown): boolean => error instanceof NovaIpcError && error.code === "unavailable";

export function createContextStore(client: ContextClient): ContextStore {
  const store = createStore<ContextSlice>()((set, get) => {
    const patch = (target: ContextTarget, change: Partial<TargetContext>): void =>
      set((state) => {
        const key = contextTargetKey(target);
        return { targets: { ...state.targets, [key]: { ...(state.targets[key] ?? EMPTY_TARGET), ...change } } };
      });
    const noteAvailability = (error: unknown): void => {
      if (isUnavailable(error)) set({ availability: "unavailable" });
    };
    const busyWhile = async <T>(target: ContextTarget, busy: TargetContext["busy"], work: () => Promise<T>): Promise<T> => {
      patch(target, { busy });
      try {
        const result = await work();
        set({ availability: "available" });
        return result;
      } catch (error) {
        noteAvailability(error);
        throw error;
      } finally {
        patch(target, { busy: null });
      }
    };

    return {
      availability: "unknown",
      targets: {},

      async load(target) {
        try {
          await busyWhile(target, "loading", async () => {
            const [usage, summaries] = await Promise.all([client.context.usage({ target }), client.context.list({ target })]);
            patch(target, { usage, summaries });
          });
        } catch {
          // Shown by the absence of data (availability) or by the next action's error.
        }
      },

      compact: (target, modelId, instructions) =>
        busyWhile(target, "compacting", async () => {
          const summary = await client.context.compact({ target, modelId, instructions });
          get().applyEvent({ type: "compaction.updated", summary });
          return summary;
        }),

      decide: (summary, decision) =>
        busyWhile(summary.target, "deciding", async () => {
          const decided = await client.context.decide({ summaryId: summary.id, decision });
          get().applyEvent({ type: "compaction.updated", summary: decided });
          return decided;
        }),

      handoff: (missionId, toModelId) =>
        busyWhile({ kind: "mission", missionId }, "switching", () => client.context.handoff({ missionId, toModelId })),

      applyEvent(event) {
        if (event.type === "context.usage") {
          patch(event.usage.target, { usage: event.usage });
          return;
        }
        const key = contextTargetKey(event.summary.target);
        const current = get().targets[key] ?? EMPTY_TARGET;
        patch(event.summary.target, { summaries: upsert(current.summaries, event.summary) });
      },
    };
  });
  // Live updates for as long as the store exists (one per client, see useContextStore).
  client.context.onEvent((event) => store.getState().applyEvent(event));
  return store;
}

/** The pending proposal of a target, if any (at most one exists). */
export function pendingSummary(target: TargetContext): CompactionSummary | null {
  return target.summaries.findLast((summary) => summary.status === "proposed") ?? null;
}
