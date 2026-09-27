// Companion service (main): subscribes to the runtime event bus (missions, watched processes,
// chat), keeps Nomi's facts, records signals BEFORE any suggestion refers to them, proposes at most
// one visible suggestion (rate-limited, approvals excepted), applies the notification policy and
// answers `companion.state` / `companion.act`. Nomi has no rights of its own: an accepted action
// goes through the same missions API as the mission card.
import {
  EMPTY_COMPANION_FACTS,
  approvalSummary,
  NOMI_COPY,
  NotificationPolicy,
  DEFAULT_SUGGESTION_INTERVAL_MS,
  describeNoticeGroup,
  rankSuggestions,
  reduceCompanionFacts,
  signalFromProcessExit,
  signalsFromMissionEvent,
  suggestionForSignal,
  summarizeProcessExit,
  type CompanionFactsState,
  type CompanionNotice,
  type NoticeInput,
  type ProducedSignal,
  type SystemNotification,
  type TerminalExit,
} from "@nova/companion";
import { redactSecrets } from "@nova/shared";
import type {
  ChatStreamEvent,
  CompanionAction,
  CompanionEvent,
  CompanionSignal,
  CompanionSignalKind,
  CompanionSourceRef,
  CompanionSuggestion,
  Mission,
  MissionEvent,
  MissionIdRequest,
} from "@nova/shared";
import type { SignalRecord, SignalRepo, SuggestionRepo } from "@nova/storage";
import type { MainApi } from "../api";
import { ServiceError } from "../service-error";

/** Signals returned by `companion.state` (contract: newest first, ≤ 50). */
const STATE_SIGNALS = 50;

type SuggestionStore = Pick<SuggestionRepo, "insert" | "get" | "latestForSignal" | "lastCreatedAt" | "decide">;
type SuggestionRecord = ReturnType<SuggestionRepo["insert"]>;
type SignalStore = Pick<SignalRepo, "insert" | "get" | "findBySource" | "listRecent" | "setState">;

export interface CompanionServiceDeps {
  signals: SignalStore;
  suggestions: SuggestionStore;
  /** Missions API of main (same service as the mission card); null until missions are wired. */
  missions: { stop(req: MissionIdRequest): Promise<Mission> } | null;
  /** Pushes `nova:companion:event` to every app window. */
  broadcast(event: CompanionEvent): void;
  /** Shows (or replaces, per group) an OS notification; clicking it focuses the target. */
  notify(notification: SystemNotification): void;
  /** Main window has the focus. */
  isFocused(): boolean;
  /** Conversation title for a chat failure notice (title and fact only, never content). */
  conversationTitle(conversationId: string): string | null;
  /** A RUNNING terminal session (P5 watch): its workspace and command; null when unknown or ended. */
  runningSession?(sessionId: string): Promise<{ workspaceId: string | null; command: string[] | null } | null>;
  now?: () => number;
  minIntervalMs?: number;
  setTimer?: (fn: () => void, ms: number) => { cancel(): void };
}

export interface WatchedCommand {
  sessionId: string;
  workspaceId: string | null;
  command: string[] | null;
  watchId: string;
}

export interface CompanionService {
  /** The `companion` IPC group (plug into `MainApiDeps.atelier.companion`). */
  api: MainApi["companion"];
  onMissionEvent(event: MissionEvent): void;
  onChatEvent(event: ChatStreamEvent): void;
  /** P5: report on this terminal session's next exit. */
  watch(sessionId: string, workspaceId: string | null, command: string[] | null): "started" | "already";
  isWatched(sessionId: string): boolean;
  /** Exit of a terminal command; ignored unless the session is watched. */
  onProcessExit(exit: Omit<TerminalExit, "workspaceId">): void;
  setQuiet(until: number | null): void;
  quietUntil(): number | null;
  notices(): CompanionNotice[];
  facts(): CompanionFactsState;
  mutedKinds(): ReadonlySet<CompanionSignalKind>;
  setMuted(kind: CompanionSignalKind, muted: boolean): void;
  dispose(): void;
}

interface StoredEvidence {
  excerpt: string | null;
  path: string | null;
  sourceRef: CompanionSourceRef;
}

function isStoredEvidence(value: unknown): value is StoredEvidence {
  return typeof value === "object" && value !== null && "sourceRef" in value && "excerpt" in value;
}

function toSignal(record: SignalRecord): CompanionSignal | null {
  if (!isStoredEvidence(record.evidence)) return null;
  const { excerpt, path, sourceRef } = record.evidence;
  return { id: record.id, kind: record.kind, workspaceId: record.workspaceId, sourceRef, evidence: { excerpt, path }, state: record.state, createdAt: record.createdAt };
}

function toSuggestion(record: SuggestionRecord): CompanionSuggestion {
  // action_json is written by this service only, from a typed CompanionAction.
  return { id: record.id, signalId: record.signalId, text: record.text, action: record.action as CompanionAction, status: record.status, createdAt: record.createdAt };
}

function missionIdOf(ref: CompanionSourceRef): string | null {
  return ref.kind === "terminal" ? null : ref.missionId;
}

/**
 * The companion is a subscriber of the runtime bus: a storage failure here must never break the
 * mission or terminal that emitted the event. It is logged (redacted), not swallowed silently.
 */
function guarded(what: string, fn: () => void): void {
  try {
    fn();
  } catch (error) {
    console.error(`companion: ${what} not recorded`, redactSecrets(error instanceof Error ? error.message : String(error)));
  }
}

function defaultTimer(fn: () => void, ms: number): { cancel(): void } {
  const handle = setTimeout(fn, ms);
  handle.unref?.();
  return { cancel: () => clearTimeout(handle) };
}

export function createCompanionService(deps: CompanionServiceDeps): CompanionService {
  const now = deps.now ?? Date.now;
  const minIntervalMs = deps.minIntervalMs ?? DEFAULT_SUGGESTION_INTERVAL_MS;
  const setTimer = deps.setTimer ?? defaultTimer;
  const policy = new NotificationPolicy((notices) => describeNoticeGroup(notices, NOMI_COPY.notify));
  const muted = new Set<CompanionSignalKind>();
  const watched = new Map<string, WatchedCommand>();
  let facts = EMPTY_COMPANION_FACTS;
  let quietUntil: number | null = null;
  let visibleId: string | null = null;
  let flushTimer: { cancel(): void } | null = null;
  let proposeTimer: { cancel(): void } | null = null;
  let watchSeq = 0;

  function recentSignals(workspaceId: string | null = null): CompanionSignal[] {
    return deps.signals
      .listRecent(STATE_SIGNALS, workspaceId)
      .map(toSignal)
      .filter((signal): signal is CompanionSignal => signal !== null);
  }

  function recordSignal(produced: ProducedSignal, missionId: string | null): CompanionSignal | null {
    const { draft, key } = produced;
    if (muted.has(draft.kind)) return null;
    // `source_ref` holds the fact identity: the same fact is recorded once, across restarts.
    if (deps.signals.findBySource(draft.kind, key)) return null;
    const evidence: StoredEvidence = { ...draft.evidence, sourceRef: draft.sourceRef };
    const stored = toSignal(deps.signals.insert({ workspaceId: draft.workspaceId, missionId, kind: draft.kind, sourceRef: key, evidence }));
    if (stored) deps.broadcast({ type: "signal", signal: stored });
    return stored;
  }

  function signalOf(suggestion: CompanionSuggestion): CompanionSignal | null {
    const stored = deps.signals.get(suggestion.signalId);
    return stored ? toSignal(stored) : null;
  }

  /** The visible suggestion, if still justified by its fact. */
  function visible(): CompanionSuggestion | null {
    if (visibleId === null) return null;
    const stored = deps.suggestions.get(visibleId);
    if (!stored || stored.status !== "proposed") return null;
    const suggestion = toSuggestion(stored);
    const signal = signalOf(suggestion);
    const mission = signal ? facts.missions[missionIdOf(signal.sourceRef) ?? ""] ?? null : null;
    return signal && suggestionForSignal(signal, mission) ? suggestion : null;
  }

  function clearVisible(): void {
    if (visibleId !== null) deps.broadcast({ type: "suggestion.cleared", suggestionId: visibleId });
    visibleId = null;
  }

  function snoozedRecently(signalId: string, at: number): boolean {
    const latest = deps.suggestions.latestForSignal(signalId);
    if (!latest) return false;
    if (latest.status === "dismissed" || latest.status === "accepted") return true;
    return latest.status === "snoozed" && latest.decidedAt !== null && at - latest.decidedAt < minIntervalMs;
  }

  function propose(): void {
    const at = now();
    const current = visible();
    if (visibleId !== null && !current) clearVisible();
    const candidates = rankSuggestions(
      recentSignals().filter((signal) => signal.state !== "ignored" && !snoozedRecently(signal.id, at)),
      facts,
      muted,
    );
    const top = candidates[0];
    if (!top || (current && current.signalId === top.signalId)) return;
    if (current && top.kind !== "approval_pending") return;
    const last = deps.suggestions.lastCreatedAt();
    // One new suggestion per interval; an approval blocks work, so it is never held back.
    if (last !== null && at - last < minIntervalMs && top.kind !== "approval_pending") {
      proposeTimer?.cancel();
      proposeTimer = setTimer(propose, last + minIntervalMs - at);
      return;
    }
    if (current) clearVisible();
    const suggestion = toSuggestion(deps.suggestions.insert({ signalId: top.signalId, text: top.text, action: top.action }));
    visibleId = suggestion.id;
    deps.signals.setState(top.signalId, "seen");
    deps.broadcast({ type: "suggestion", suggestion });
  }

  function scheduleFlush(): void {
    flushTimer?.cancel();
    flushTimer = null;
    const due = policy.nextFlushAt();
    if (due === null) return;
    flushTimer = setTimer(() => {
      for (const notification of policy.flushDue({ focused: deps.isFocused(), now: now(), quietUntil })) deps.notify(notification);
      scheduleFlush();
    }, Math.max(0, due - now()));
  }

  function notice(input: NoticeInput): void {
    const { system } = policy.push(input, { focused: deps.isFocused(), now: now(), quietUntil });
    if (system) deps.notify(system);
    scheduleFlush();
  }

  function missionNotice(event: MissionEvent): NoticeInput | null {
    const title = facts.missions[event.missionId]?.title ?? null;
    const group = { entityType: "mission" as const, entityId: event.missionId, groupKey: event.missionId };
    switch (event.type) {
      case "approval.requested":
        return {
          kind: "approval",
          entityType: "approval",
          entityId: event.approval.id,
          groupKey: event.missionId,
          text: NOMI_COPY.notify.approval(title, approvalSummary(event.approval)),
        };
      case "mission.succeeded":
        return { kind: "mission_succeeded", ...group, text: NOMI_COPY.notify.succeeded(title) };
      case "mission.failed":
        return { kind: "mission_failed", ...group, text: NOMI_COPY.notify.failed(title, NOMI_COPY.missionFailure[event.reason]) };
      case "mission.suspended":
        return event.reason === "user"
          ? null
          : { kind: "mission_suspended", ...group, text: NOMI_COPY.notify.suspended(title, NOMI_COPY.suspendReason[event.reason]) };
      default:
        return null;
    }
  }

  const service: CompanionService = {
    api: {
      async state({ workspaceId }) {
        return { suggestion: visible(), signals: recentSignals(workspaceId) };
      },

      async act({ suggestionId, response }) {
        const stored = deps.suggestions.get(suggestionId);
        if (!stored) throw new ServiceError("not_found", "Suggestion not found");
        if (stored.status !== "proposed") throw new ServiceError("conflict", "Suggestion already answered");
        const suggestion = toSuggestion(stored);
        if (visibleId === suggestionId) clearVisible();
        if (response === "snooze") {
          const decided = deps.suggestions.decide(suggestionId, "snoozed");
          return { suggestion: toSuggestion(decided ?? stored), performedByMain: false, navigate: null };
        }
        if (response === "dismiss" || response === "mute_kind") {
          const signal = signalOf(suggestion);
          if (signal) deps.signals.setState(signal.id, "ignored");
          if (response === "mute_kind" && signal) muted.add(signal.kind);
          const decided = deps.suggestions.decide(suggestionId, "dismissed");
          return { suggestion: toSuggestion(decided ?? stored), performedByMain: false, navigate: null };
        }
        const action = suggestion.action;
        if (action.type === "stop_mission") {
          if (!deps.missions) throw new ServiceError("unavailable", "missions are not available yet");
          await deps.missions.stop({ missionId: action.missionId });
          const decided = deps.suggestions.decide(suggestionId, "accepted");
          return { suggestion: toSuggestion(decided ?? stored), performedByMain: true, navigate: null };
        }
        // Navigation actions (approval card, explanation, changes, diff, watch, mission contract):
        // the renderer opens the view through its own validated calls.
        const decided = deps.suggestions.decide(suggestionId, "accepted");
        return { suggestion: toSuggestion(decided ?? stored), performedByMain: false, navigate: action };
      },

      async watch({ sessionId }) {
        const session = (await deps.runningSession?.(sessionId)) ?? null;
        if (!session) return { status: "none", command: null };
        return { status: service.watch(sessionId, session.workspaceId, session.command), command: session.command };
      },

      async setQuiet({ until }) {
        service.setQuiet(until);
      },

      async notices() {
        return policy.notices();
      },
    },

    onMissionEvent(event) {
      facts = reduceCompanionFacts(facts, event);
      guarded("mission event", () => {
        const mission = facts.missions[event.missionId] ?? null;
        for (const produced of signalsFromMissionEvent(event, mission)) recordSignal(produced, event.missionId);
        const input = missionNotice(event);
        if (input) notice(input);
        propose();
      });
    },

    onChatEvent(event) {
      if (event.type !== "failed") return;
      // A failure in the conversation on screen is shown under the message; a system
      // notification only when the window is in the background (P13).
      if (deps.isFocused()) return;
      const title = deps.conversationTitle(event.conversationId) ?? "Conversation";
      notice({
        kind: "chat_failed",
        entityType: "conversation",
        entityId: event.conversationId,
        groupKey: event.conversationId,
        text: NOMI_COPY.notify.chatFailed(title, NOMI_COPY.chatFailure[event.error.code]),
      });
    },

    watch(sessionId, workspaceId, command) {
      if (watched.has(sessionId)) return "already";
      watchSeq += 1;
      watched.set(sessionId, { sessionId, workspaceId, command, watchId: `${now()}-${watchSeq}` });
      return "started";
    },

    isWatched: (sessionId) => watched.has(sessionId),

    onProcessExit(exit) {
      const watch = watched.get(exit.sessionId);
      if (!watch) return;
      watched.delete(exit.sessionId);
      guarded("process exit", () => {
        const report = summarizeProcessExit(exit);
        const produced = signalFromProcessExit({ ...exit, workspaceId: watch.workspaceId }, watch.watchId);
        if (produced) recordSignal(produced, null);
        notice({ kind: "watch_done", entityType: "terminal", entityId: exit.sessionId, groupKey: exit.sessionId, text: report.text });
        propose();
      });
    },

    setQuiet(until) {
      quietUntil = until !== null && until > now() ? until : null;
    },
    quietUntil: () => (quietUntil !== null && quietUntil > now() ? quietUntil : null),
    notices: () => policy.notices(),
    facts: () => facts,
    mutedKinds: () => muted,
    setMuted(kind, value) {
      if (value) muted.add(kind);
      else muted.delete(kind);
    },

    dispose() {
      flushTimer?.cancel();
      proposeTimer?.cancel();
      flushTimer = null;
      proposeTimer = null;
    },
  };
  return service;
}
