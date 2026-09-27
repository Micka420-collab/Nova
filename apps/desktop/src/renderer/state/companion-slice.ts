// Nomi's renderer state (zustand, standalone until merged into the app store): companion facts
// projected from mission events, the visible suggestion and recent signals pushed by main, and the
// outcome bubble of the last action. Every action the user triggers ends in `bubble`.
import {
  EMPTY_COMPANION_FACTS,
  NOMI_COPY,
  outcomeFromError,
  performNomiAction,
  reduceCompanionFacts,
  type ActionOutcome,
  type CompanionFactsState,
  type NomiActionPorts,
  type NomiMenuAction,
} from "@nova/companion";
import {
  NovaIpcError,
  isTerminalMissionState,
  type CompanionAction,
  type CompanionActRequest,
  type CompanionEvent,
  type CompanionSignal,
  type CompanionSuggestion,
  type MissionEvent,
  type NovaApi,
} from "@nova/shared";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { LastOutcome } from "./nomi";

export type CompanionClient = Pick<NovaApi, "companion" | "missions" | "approvals">;

export interface CompanionData {
  facts: CompanionFactsState;
  /** The single visible suggestion (main decides; at most one). */
  suggestion: CompanionSuggestion | null;
  /** Recent signals, newest first (text view of the companion, scenario 14). */
  signals: CompanionSignal[];
  /** Outcome of the last action: shown in Nomi's bubble until dismissed. */
  bubble: ActionOutcome | null;
  /** Last terminal mission event, for the success/error pose. */
  missionOutcome: (LastOutcome & { title: string | null }) | null;
  quietUntil: number | null;
  menuOpen: boolean;
  /** An action is running (the menu shows it; a second click waits). */
  busy: boolean;
}

export interface CompanionActions {
  /** Reads main's companion state and rebuilds facts of the active missions from their logs. */
  hydrate(workspaceId: string | null): Promise<void>;
  applyCompanionEvent(event: CompanionEvent): void;
  applyMissionEvent(event: MissionEvent): void;
  /** Answer to the visible suggestion (« Regarde », « Plus tard », « Ignore ce type de signal »). */
  respond(response: CompanionActRequest["response"]): Promise<ActionOutcome>;
  /** Menu or palette entry; same code path for both. */
  run(action: NomiMenuAction): Promise<ActionOutcome>;
  /** Outcome of a companion gesture handled outside the executor (file drop, model question). */
  showOutcome(outcome: ActionOutcome): void;
  dismissBubble(): void;
  setMenuOpen(open: boolean): void;
}

export type CompanionState = CompanionData & CompanionActions;
export type CompanionStore = StoreApi<CompanionState>;

export interface CompanionStoreDeps {
  client: CompanionClient;
  /** Opens the view an action points to (approval card, mission, diff, terminal, plan). */
  navigate(action: CompanionAction): void;
  openSettings(): void;
  /** P5 watch in main; absent until `companion.watch` exists in the IPC contract. */
  watch?: NomiActionPorts["watch"];
  now?: () => number;
}

/** Active missions rebuilt at start (bounded: a projection, not a history browser). */
const HYDRATE_MISSIONS = 5;

const unavailableWatch: NomiActionPorts["watch"] = () =>
  Promise.reject(new NovaIpcError({ code: "unavailable", message: "companion.watch is not in the contract yet" }));

const MISSION_OUTCOMES: Partial<Record<MissionEvent["type"], LastOutcome["kind"]>> = {
  "mission.succeeded": "success",
  "mission.failed": "error",
  "mission.cancelled": "stopped",
};

export function createCompanionStore(deps: CompanionStoreDeps): CompanionStore {
  const now = deps.now ?? Date.now;
  return createStore<CompanionState>()((set, get) => {
    const ports: NomiActionPorts = {
      missions: {
        get: (req) => deps.client.missions.get(req),
        stop: (req) => deps.client.missions.stop(req),
        resume: (req) => deps.client.missions.resume(req),
      },
      approvals: { list: (req) => deps.client.approvals.list(req) },
      watch: deps.watch ?? unavailableWatch,
      setQuiet: (until) => set({ quietUntil: until }),
    };

    async function finish(outcome: ActionOutcome): Promise<ActionOutcome> {
      if (outcome.ok && outcome.navigate) deps.navigate(outcome.navigate);
      set({ bubble: outcome, busy: false, menuOpen: false });
      return outcome;
    }

    return {
      facts: EMPTY_COMPANION_FACTS,
      suggestion: null,
      signals: [],
      bubble: null,
      missionOutcome: null,
      quietUntil: null,
      menuOpen: false,
      busy: false,

      async hydrate(workspaceId) {
        try {
          const state = await deps.client.companion.state({ workspaceId });
          set({ suggestion: state.suggestion, signals: state.signals });
        } catch {
          // Companion group not wired yet: no suggestion is the honest state.
        }
        try {
          const page = await deps.client.missions.list({ workspaceId, limit: 20 });
          const active = page.items.filter((mission) => !isTerminalMissionState(mission.state)).slice(0, HYDRATE_MISSIONS);
          const details = await Promise.all(active.map((mission) => deps.client.missions.get({ missionId: mission.id, afterSeq: 0 })));
          let facts = get().facts;
          for (const detail of details) for (const event of detail.events) facts = reduceCompanionFacts(facts, event);
          set({ facts });
        } catch {
          // Missions unavailable: facts stay empty (unknown, never invented).
        }
      },

      applyCompanionEvent(event) {
        if (event.type === "signal") {
          set((state) => ({ signals: [event.signal, ...state.signals.filter((s) => s.id !== event.signal.id)].slice(0, 50) }));
        } else if (event.type === "suggestion") {
          set({ suggestion: event.suggestion });
        } else if (get().suggestion?.id === event.suggestionId) {
          set({ suggestion: null });
        }
      },

      applyMissionEvent(event) {
        const facts = reduceCompanionFacts(get().facts, event);
        const kind = MISSION_OUTCOMES[event.type];
        if (kind) {
          const title = facts.missions[event.missionId]?.title ?? null;
          set({ facts, missionOutcome: { kind, at: event.at, title } });
        } else if (facts !== get().facts) {
          set({ facts });
        }
      },

      async respond(response) {
        const suggestion = get().suggestion;
        if (!suggestion) return finish({ ok: false, reason: "nothing_to_do", message: NOMI_COPY.outcome.dismissed });
        set({ busy: true });
        try {
          const result = await deps.client.companion.act({ suggestionId: suggestion.id, response });
          set({ suggestion: null });
          if (response === "snooze") return finish({ ok: true, message: NOMI_COPY.outcome.snoozed, navigate: null });
          if (response === "dismiss") return finish({ ok: true, message: NOMI_COPY.outcome.dismissed, navigate: null });
          if (response === "mute_kind") return finish({ ok: true, message: NOMI_COPY.outcome.muted, navigate: null });
          if (result.performedByMain) {
            const missionId = suggestion.action.type === "stop_mission" ? suggestion.action.missionId : null;
            const title = missionId ? (get().facts.missions[missionId]?.title ?? null) : null;
            return finish({ ok: true, message: NOMI_COPY.outcome.missionStopped(title), navigate: null });
          }
          const action = result.navigate ?? suggestion.action;
          return finish(await performNomiAction(action, ports, now()));
        } catch (error) {
          return finish(outcomeFromError(error));
        }
      },

      async run(action) {
        if (action.type === "open_settings") {
          // The settings page opening is the visible outcome: no bubble over it.
          deps.openSettings();
          set({ menuOpen: false });
          return { ok: true, message: NOMI_COPY.menu.settings, navigate: null };
        }
        set({ busy: true });
        return finish(await performNomiAction(action, ports, now()));
      },

      showOutcome(outcome) {
        set({ bubble: outcome, busy: false });
      },

      dismissBubble() {
        set({ bubble: null });
      },

      setMenuOpen(open) {
        set({ menuOpen: open });
      },
    };
  });
}

/** Subscribes the store to main's pushes; returns the unsubscribe function. */
export function connectCompanion(store: CompanionStore, client: Pick<NovaApi, "companion" | "missions">): () => void {
  const offCompanion = client.companion.onEvent((event) => store.getState().applyCompanionEvent(event));
  const offMissions = client.missions.onEvent((event) => store.getState().applyMissionEvent(event));
  return () => {
    offCompanion();
    offMissions();
  };
}
