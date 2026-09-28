import {
  EMPTY_COMPANION_FACTS,
  NOMI_COPY,
  buildNomiMenu,
  chatFactSuggestions,
  currentActivity,
  focusMission,
  planModelExplanation,
  type ChangeLine,
  type CompanionFactsState,
  type Explanation,
  type FactAction,
  type NomiMenuFacts,
} from "@nova/companion";
import type { CompanionSignal, ModelInfo } from "@nova/shared";
import { Nomi, StatusPill, type BadgeTone, type NomiState } from "@nova/ui";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useStore } from "zustand";
import { fr } from "../../copy/fr";
import { describeProviderError, describeUiError, toUiError } from "../../lib/errors";
import { REDUCED_MOTION_QUERY, useMediaQuery, useOnline } from "../../lib/hooks";
import { useApp, useAppStore } from "../../state/context";
import { OUTCOME_WINDOW_MS, deriveNomiState } from "../../state/nomi";
import { companionPhase, selectedModelId, type AppData } from "../../state/store";
import { createTerminalStore } from "../../state/terminal-slice";
import { useCompanion, useCompanionStore } from "../companion/CompanionContext";
import { NomiBubble } from "../companion/NomiBubble";
import { NomiMenu } from "../companion/NomiMenu";
import { useNomiDrop } from "../companion/useNomiDrop";
import { useOptionalShellServices } from "./AtelierHost";
// oxlint-disable-next-line import/no-unassigned-import -- side-effect stylesheet (extracted to a file by Vite)
import "../companion/companion.css";

/** Stand-in when no shell (and so no terminal) is around: nothing to watch. */
const EMPTY_TERMINAL_STORE = createTerminalStore();

/** Title of the conversation the last outcome belongs to, when the chat view does not show it. */
function outcomeElsewhere(state: AppData): string | null {
  const outcome = state.lastOutcome;
  if (!outcome) return null;
  if (state.ui.route === "chat" && state.activeId === outcome.conversationId) return null;
  const summary = state.conversations.find((item) => item.id === outcome.conversationId);
  const title = summary?.title ?? (state.detail?.conversation.id === outcome.conversationId ? state.detail.conversation.title : null);
  return title ?? fr.conversation.untitled;
}

const PILL_TONES: Record<NomiState, BadgeTone> = {
  offline: "neutral",
  idle: "jade",
  listening: "jade",
  thinking: "jade",
  working: "jade",
  waiting: "amber",
  speaking: "jade",
  success: "jade",
  error: "danger",
};

const EMPTY_SIGNALS: CompanionSignal[] = [];
const NO_FACTS: readonly string[] = [];

/** States announced to screen readers (NOMI.md §5): terminal transitions only, never thinking → working. */
const ANNOUNCED_STATES: ReadonlySet<NomiState> = new Set(["success", "error", "waiting"]);
const MINUTE_MS = 60_000;

/**
 * Wakes the dock only when something can change on screen: when a success/error pose expires and
 * once a minute for relative times. No per-second timer at rest (POWER_UX §7.8).
 */
function useDockClock(outcomeAt: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), MINUTE_MS);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (outcomeAt === null) return undefined;
    const remaining = outcomeAt + OUTCOME_WINDOW_MS - Date.now();
    if (remaining <= 0) return undefined;
    const timer = setTimeout(() => setNow(Date.now()), remaining);
    return () => clearTimeout(timer);
  }, [outcomeAt]);
  // A fresh outcome shows at once (its timestamp is later than the last tick).
  return Math.max(now, outcomeAt ?? 0);
}

/** The newest error Nomi can explain: a failed answer, or a failed test/command of the mission. */
function recentError(lastOutcome: AppData["lastOutcome"], facts: CompanionFactsState): NomiMenuFacts["recentError"] {
  const chat = lastOutcome?.kind === "error" && lastOutcome.error ? lastOutcome : null;
  const mission = focusMission(facts);
  const failure = mission?.unresolvedFailure ?? null;
  if (failure && mission && (!chat || failure.at >= chat.at)) {
    return { kind: "ref", sourceRef: { kind: "tool_call", toolCallId: failure.callId, missionId: mission.missionId } };
  }
  if (chat?.error) {
    const copy = describeProviderError(chat.error);
    return { kind: "source", source: { kind: "provider", info: chat.error, copy: { title: copy.title, detail: copy.detail } } };
  }
  return null;
}

/** Companion at the bottom of the navigation: status, P9 menu, bubble, drop target. */
export function NomiDock() {
  const online = useOnline();
  const connection = useApp((state) => state.connection);
  const phase = useApp(companionPhase);
  const lastOutcome = useApp((state) => state.lastOutcome);
  const elsewhere = useApp(outcomeElsewhere);
  const companion = useApp((state) => state.settings?.companion ?? null);
  const openSettings = useApp((state) => state.openSettings);
  const approvals = useApp((state) => state.approvals);
  const appStore = useAppStore();
  const catalog = useApp((state) => state.catalog.data);
  const nextModelId = useApp((state) => selectedModelId(state, state.activeId));
  const newModelId = useApp((state) => selectedModelId(state, null));
  const systemReduced = useMediaQuery(REDUCED_MOTION_QUERY);

  const companionStore = useCompanionStore();
  const shell = useOptionalShellServices();
  // P5: the terminal on screen, while its command runs, can be watched by Nomi.
  const unwatchedSessionId = useStore(shell?.terminal ?? EMPTY_TERMINAL_STORE, (state) => {
    const active = state.sessions.find((session) => session.id === state.activeId);
    return active && active.state === "running" && active.owner === "user" ? active.id : null;
  });
  const facts = useCompanion((state) => state.facts, EMPTY_COMPANION_FACTS);
  const missionOutcome = useCompanion((state) => state.missionOutcome, null);
  const quietUntil = useCompanion((state) => state.quietUntil, null);
  const suggestion = useCompanion((state) => state.suggestion, null);
  const signals = useCompanion((state) => state.signals, EMPTY_SIGNALS);
  const bubble = useCompanion((state) => state.bubble, null);
  const menuOpen = useCompanion((state) => state.menuOpen, false);
  const busy = useCompanion((state) => state.busy, false);
  const dismissedFacts = useCompanion((state) => state.dismissedFacts, NO_FACTS);

  const latestOutcomeAt = Math.max(lastOutcome?.at ?? 0, missionOutcome?.at ?? 0) || null;
  const now = useDockClock(latestOutcomeAt);
  const mission = focusMission(facts);
  const pendingCount = useMemo(() => Object.values(approvals).filter((a) => a.status === "pending").length, [approvals]);
  const view = deriveNomiState({
    online,
    connection,
    activeStreamPhase: phase,
    lastOutcome,
    outcomeElsewhere: elsewhere,
    mission,
    activity: currentActivity(mission),
    approvalsPending: pendingCount,
    missionOutcome,
    quietUntil,
    now,
  });
  const reduced = companion?.motion === "reduce" || (companion?.motion !== "full" && systemReduced);
  const busyStream = phase !== null;
  const menuId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);

  const drop = useNomiDrop(
    companionStore
      ? {
          imageInput: imageInputOf(catalog?.models ?? [], nextModelId),
          attachText: (_name, block) => appStore.getState().draftIntoChat(block),
          chooseModel: () => {
            const state = appStore.getState();
            state.openModelPicker(state.activeId ? "conversation" : "new");
          },
          openWorkspace: () =>
            void appStore
              .getState()
              .openWorkspace()
              .catch((error: unknown) =>
                companionStore.getState().showOutcome({
                  ok: false,
                  reason: "failed",
                  message: NOMI_COPY.outcome.failed(describeUiError(toUiError(error)).title),
                }),
              ),
          showOutcome: (outcome) => companionStore.getState().showOutcome(outcome),
        }
      : null,
  );

  if (!companionStore) return <LegacyDock view={view} reduced={reduced} busy={busyStream} compact={Boolean(companion && !companion.visible)} onOpen={() => openSettings("companion")} />;

  const menuEntries = buildNomiMenu({
    mission,
    pendingApprovals: Object.values(approvals).filter((a) => a.status === "pending"),
    recentError: recentError(lastOutcome, facts),
    unwatchedSessionId,
    quietUntil,
    now,
  });
  const status = `${view.label} · ${view.detail}`;
  const signal = suggestion ? (signals.find((item) => item.id === suggestion.signalId) ?? null) : null;
  const explanation = bubble?.ok ? bubble.explanation : undefined;
  const askModel =
    explanation && newModelId
      ? askModelFor(explanation, newModelId, catalog?.models ?? [], (prompt, modelName) => {
          const state = appStore.getState();
          // The answer lands in a new conversation: show the new-chat view, which send() then
          // replaces with that conversation. Nomi confirms only once main accepted the question.
          state.showChat();
          state.newConversation();
          state.send(prompt, null).then(
            () => companionStore.getState().showOutcome({ ok: true, message: NOMI_COPY.outcome.askedModel(modelName), navigate: null }),
            // The chat route's own error copy (offline, key refused…), not a generic action failure.
            (error: unknown) =>
              companionStore.getState().showOutcome({
                ok: false,
                reason: "failed",
                message: NOMI_COPY.outcome.failed(describeUiError(toUiError(error)).title),
              }),
          );
        })
      : null;

  function closeMenu() {
    companionStore?.getState().setMenuOpen(false);
    triggerRef.current?.focus();
  }

  function openLine(line: ChangeLine) {
    const target = line.target;
    if (!target) return;
    const state = appStore.getState();
    if (target.kind === "diff") state.navigateCompanion({ type: "show_changes", missionId: target.missionId });
    else state.selectMission(target.missionId);
  }

  const failure = lastOutcome?.kind === "error" && lastOutcome.error && elsewhere !== null ? lastOutcome : null;
  const fact =
    chatFactSuggestions({
      keyAbsent: connection === null ? null : connection.state === "absent",
      lastFailure: failure?.error
        ? { conversationId: failure.conversationId, at: failure.at, code: failure.error.code, retryable: failure.error.retryable }
        : null,
    }).find((item) => !dismissedFacts.includes(item.factId)) ?? null;

  function runFact(action: FactAction) {
    const state = appStore.getState();
    if (action.type === "open_provider_settings") state.openSettings("providers");
    else {
      state.openConversation(action.conversationId);
      if (action.type === "choose_model") state.openModelPicker("conversation");
    }
  }

  const compact = Boolean(companion && !companion.visible);
  const announcement = ANNOUNCED_STATES.has(view.state) ? status : "";
  return (
    <div className="nova-dock-wrap" {...drop.targetProps}>
      {menuOpen ? (
        <NomiMenu
          id={menuId}
          status={status}
          entries={menuEntries}
          busy={busy}
          onSelect={(entry) => void companionStore.getState().run(entry.action)}
          onClose={closeMenu}
        />
      ) : null}
      <NomiBubble
        outcome={bubble}
        suggestion={suggestion}
        signal={signal}
        drop={drop.drop}
        fact={fact}
        onFactAction={runFact}
        onFactDismiss={(factId) => companionStore.getState().dismissFact(factId)}
        askModel={askModel}
        busy={busy}
        onRespond={(response) => void companionStore.getState().respond(response)}
        onOpenLine={openLine}
        onDismiss={() => companionStore.getState().dismissBubble()}
      />
      <button
        ref={triggerRef}
        type="button"
        className={compact ? "nova-dock nova-dock--compact" : "nova-dock"}
        title={NOMI_COPY.menu.label}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-controls={menuOpen ? menuId : undefined}
        onClick={() => companionStore.getState().setMenuOpen(!menuOpen)}
      >
        {compact ? (
          <>
            <StatusPill tone={PILL_TONES[view.state]} active={busyStream}>
              {view.label}
            </StatusPill>
            <span className="nova-dock__detail">{view.detail}</span>
          </>
        ) : (
          <>
            <span className="nova-dock__figure" aria-hidden>
              <Nomi
                state={view.state}
                activity={view.activity}
                waiting={view.waiting}
                quiet={view.quiet}
                dragOver={drop.dragOver}
                size={44}
                motion={reduced ? "reduced" : "full"}
              />
            </span>
            <span className="nova-dock__text">
              <span className="nova-dock__label">{view.label}</span>
              <span className="nova-dock__detail">{view.detail}</span>
            </span>
          </>
        )}
      </button>
      <span className="nova-nomi-announce" aria-live="polite">
        {announcement}
      </span>
    </div>
  );
}

function imageInputOf(models: readonly ModelInfo[], modelId: string | null): boolean | null {
  const model = modelId ? models.find((item) => item.id === modelId) : undefined;
  if (!model?.inputModalities) return null;
  return model.inputModalities.includes("image");
}

/**
 * Level 2 of « Explique cette erreur »: shown only when a model is chosen (its price may be
 * unknown, then said so). The question goes through the regular chat route, so usage records it.
 */
function askModelFor(
  explanation: Explanation,
  modelId: string,
  models: readonly ModelInfo[],
  send: (prompt: string, modelName: string) => void,
) {
  const model = models.find((item) => item.id === modelId) ?? null;
  const name = model?.name ?? modelId;
  const plan = planModelExplanation(explanation, { path: null, line: null, command: null, text: null }, { name, pricing: model?.pricing ?? null });
  return { plan, onAsk: () => send(plan.prompt, name) };
}

/** J1 dock, used until the companion store is provided: status, and a click opens the settings. */
function LegacyDock({
  view,
  reduced,
  busy,
  compact,
  onOpen,
}: {
  view: ReturnType<typeof deriveNomiState>;
  reduced: boolean;
  busy: boolean;
  compact: boolean;
  onOpen(): void;
}) {
  if (compact) {
    return (
      <button type="button" className="nova-dock nova-dock--compact" onClick={onOpen}>
        <StatusPill tone={PILL_TONES[view.state]} active={busy}>
          {view.label}
        </StatusPill>
        <span className="nova-dock__detail">{view.detail}</span>
      </button>
    );
  }
  return (
    <button type="button" className="nova-dock" title={fr.nomi.openSettings} onClick={onOpen}>
      <span className="nova-dock__figure" aria-hidden>
        <Nomi state={view.state} activity={view.activity} waiting={view.waiting} quiet={view.quiet} size={44} motion={reduced ? "reduced" : "full"} />
      </span>
      <span className="nova-dock__text">
        <span className="nova-dock__label">{view.label}</span>
        <span className="nova-dock__detail">{view.detail}</span>
      </span>
    </button>
  );
}
