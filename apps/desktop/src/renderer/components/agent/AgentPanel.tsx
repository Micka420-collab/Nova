// Agent panel (VISUAL.md §4.4, UX.md §4.4): header with the real state and the budget, the work-mode
// selector (A12), then either the conversation (Discuter) or the mission flow: goal → plan + contract
// sheet → live timeline → end card. Approvals wait in the timeline; a reminder sits above the input.
import { useEffect, useRef, useState } from "react";
import {
  BudgetMeter,
  Button,
  Callout,
  Dialog,
  EmptyState,
  OrbitIndicator,
  SegmentedControl,
  Skeleton,
  StatusPill,
  useToast,
  type BadgeTone,
} from "@nova/ui";
import { WORK_MODES, type MissionState, type WorkMode } from "@nova/shared";
import { fr } from "../../copy/fr";
import { MISSION_STATE_LABELS, WORK_MODE_HINTS, WORK_MODE_LABELS } from "../../copy/fr-atelier";
import { describeUiError, errorToast } from "../../lib/errors";
import { formatCost, formatRelative } from "../../lib/format";
import { useNow, useOnline } from "../../lib/hooks";
import { useApp } from "../../state/context";
import { pendingApprovalList, selectedMissionView, selectedModelId } from "../../state/store";
import { ChatView } from "../chat/ChatView";
import { Composer, type ComposerBlock } from "../chat/Composer";
import { useSendGuard } from "../chat/useSendGuard";
import { findModel } from "../models/filter";
import { isMissionActive, type MissionView } from "../missions/timeline";
import { approvalTargetText } from "./AgentApproval";
import { ContractSheet } from "./ContractSheet";
import { ContextInspector, MentionPicker, useMentionPicker } from "./GoalContext";
import { MissionTimeline } from "./MissionTimeline";
import { installTypingTracker } from "./typing";

const copy = fr.atelier;

export const MISSION_STATE_TONES: Record<MissionState, BadgeTone> = {
  ready: "neutral",
  running: "jade",
  waiting_approval: "amber",
  suspended: "amber",
  succeeded: "jade",
  failed: "danger",
  cancelled: "neutral",
};

export function budgetFormat(usd: number): string {
  return formatCost(usd) ?? fr.app.unknown;
}

function MissionActions({ view }: { view: MissionView }) {
  const pauseMission = useApp((state) => state.pauseMission);
  const resumeMission = useApp((state) => state.resumeMission);
  const stopMission = useApp((state) => state.stopMission);
  const openDoc = useApp((state) => state.openDoc);
  const toast = useToast();
  const [confirmStop, setConfirmStop] = useState(false);
  const id = view.mission.id;
  const state = view.mission.state;
  const act = (action: () => Promise<void>) =>
    action().catch((error: unknown) => toast.show(errorToast(error, copy.mission.actionFailed)));
  return (
    <span className="nova-agent__actions">
      <Button size="sm" variant="ghost" onClick={() => openDoc({ kind: "mission", missionId: id })}>
        {copy.mission.openCard}
      </Button>
      {state === "running" || state === "waiting_approval" ? (
        <Button size="sm" variant="ghost" onClick={() => act(() => pauseMission(id))}>
          {copy.mission.pause}
        </Button>
      ) : null}
      {state === "suspended" ? (
        <Button size="sm" variant="secondary" onClick={() => act(() => resumeMission(id))}>
          {copy.mission.resume}
        </Button>
      ) : null}
      {isMissionActive(view) ? (
        <Button size="sm" variant="ghost" onClick={() => setConfirmStop(true)}>
          {copy.mission.stop}
        </Button>
      ) : null}
      <Dialog
        open={confirmStop}
        onClose={() => setConfirmStop(false)}
        title={copy.mission.stopConfirmTitle}
        description={copy.mission.stopConfirmBody}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmStop(false)}>
              {fr.app.cancel}
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                setConfirmStop(false);
                act(() => stopMission(id));
              }}
            >
              {copy.mission.stopConfirm}
            </Button>
          </>
        }
      />
    </span>
  );
}

/** Header: one orbit for the whole panel (single focus), the state in words, the budget inline. */
function AgentHeader({ view }: { view: MissionView | null }) {
  const planning = useApp((state) => state.missions.plan.status === "planning");
  const selectMission = useApp((state) => state.selectMission);
  const running = view?.mission.state === "running";
  const waiting = view?.mission.state === "waiting_approval";
  const label = planning
    ? copy.agent.planning
    : running
      ? copy.agent.working
      : waiting
        ? copy.agent.waiting
        : view
          ? MISSION_STATE_LABELS[view.mission.state]
          : null;
  return (
    <header className="nova-agent__header">
      <span className="nova-agent__state">
        {planning || running ? <OrbitIndicator active size={16} label={label ?? undefined} /> : null}
        {view ? (
          <StatusPill tone={MISSION_STATE_TONES[view.mission.state]}>{label}</StatusPill>
        ) : planning ? (
          <span>{label}</span>
        ) : (
          <span className="nova-agent__title">{copy.agent.title}</span>
        )}
      </span>
      {view ? <span className="nova-agent__mission">{view.mission.title}</span> : null}
      {view?.budget ? (
        <BudgetMeter
          variant="inline"
          spentUsd={view.budget.spentUsd}
          reservedUsd={view.budget.reservedUsd}
          capUsd={view.budget.budgetUsd}
          unknownCostCalls={view.budget.unknownCostCalls}
          format={budgetFormat}
          labels={copy.budget}
          suspended={view.mission.state === "suspended"}
        />
      ) : null}
      {view ? (
        <>
          <MissionActions view={view} />
          <Button size="sm" variant="ghost" onClick={() => selectMission(null)}>
            {copy.agent.backToChat}
          </Button>
        </>
      ) : null}
    </header>
  );
}

function ModeBar() {
  const mode = useApp((state) => state.workMode);
  const setWorkMode = useApp((state) => state.setWorkMode);
  const selectMission = useApp((state) => state.selectMission);
  const options = WORK_MODES.map((value) => ({ value, label: WORK_MODE_LABELS[value] }));
  return (
    <div className="nova-agent__modes">
      <SegmentedControl<WorkMode>
        label={copy.agent.modeLabel}
        options={options}
        value={mode}
        size="sm"
        onChange={(next) => {
          setWorkMode(next);
          selectMission(null);
        }}
      />
      <p className="nova-agent__mode-hint">{WORK_MODE_HINTS[mode]}</p>
    </div>
  );
}

/** Why a mission cannot be planned now, with the step that fixes it. */
function useMissionGuard(): ComposerBlock | null {
  const workspace = useApp((state) => state.workspace.current);
  const modelId = useApp((state) => selectedModelId(state, state.activeId));
  const models = useApp((state) => state.catalog.data?.models);
  const openWorkspace = useApp((state) => state.openWorkspace);
  const openModelPicker = useApp((state) => state.openModelPicker);
  const toast = useToast();
  const base = useSendGuard(modelId, "conversation");
  if (!workspace) {
    return {
      reason: copy.agent.needsWorkspace,
      action: {
        label: copy.shell.openFolder,
        onAction: () => {
          openWorkspace().catch((error: unknown) => toast.show(errorToast(error, copy.shell.folderOpenFailed)));
        },
      },
    };
  }
  if (base) return base;
  if (findModel(models, modelId)?.supportsTools === false) {
    return { reason: copy.agent.noTools, action: { label: copy.agent.chooseToolModel, onAction: () => openModelPicker("conversation") } };
  }
  return null;
}

function RecentMissions() {
  const list = useApp((state) => state.missions.list);
  const status = useApp((state) => state.missions.listStatus);
  const selectMission = useApp((state) => state.selectMission);
  const now = useNow(60_000);
  if (status === "loading") {
    return (
      <div aria-busy="true" className="nova-agent__recent">
        <Skeleton height={36} />
        <Skeleton height={36} />
      </div>
    );
  }
  if (list.length === 0) return null;
  return (
    <section className="nova-agent__recent" aria-label={copy.agent.missionsHeading}>
      <h3 className="nova-agent__subtitle">{copy.agent.missionsHeading}</h3>
      <ul>
        {list.slice(0, 5).map((mission) => (
          <li key={mission.id}>
            <button type="button" className="nova-agent__recent-item" onClick={() => selectMission(mission.id)}>
              <span className="nova-agent__recent-title">{mission.title}</span>
              <StatusPill tone={MISSION_STATE_TONES[mission.state]} active={mission.state === "running"}>
                {MISSION_STATE_LABELS[mission.state]}
              </StatusPill>
              <span className="nova-note">{formatRelative(mission.updatedAt, now)}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function GoalComposer({ mode }: { mode: Exclude<WorkMode, "discuss"> }) {
  const planMission = useApp((state) => state.planMission);
  const hasWorkspace = useApp((state) => state.workspace.current !== null);
  const hasMissions = useApp((state) => state.missions.list.length > 0);
  const guard = useMissionGuard();
  const [goal, setGoal] = useState("");
  const picker = useMentionPicker(goal, setGoal);
  const suggestions = [copy.agent.suggestionUnderstand, copy.agent.suggestionVerify, copy.agent.suggestionFix];
  return (
    <div className="nova-agent__goal">
      {hasWorkspace && !hasMissions ? (
        <EmptyState title={copy.agent.noMission} description={copy.agent.noMissionBody} headingLevel={3} />
      ) : null}
      <RecentMissions />
      {hasWorkspace ? (
        <fieldset className="nova-agent__suggestions">
          <legend className="nv-visually-hidden">{copy.agent.suggestions}</legend>
          {suggestions.map((text) => (
            <Button key={text} size="sm" variant="secondary" onClick={() => setGoal(text)}>
              {text}
            </Button>
          ))}
        </fieldset>
      ) : null}
      {/* Capture phase: the mention picker takes ↑ ↓ Entrée Échap only while it is open. */}
      <div className="nova-agent__composer" onKeyDownCapture={picker.onKeyDownCapture}>
        <MentionPicker picker={picker} />
        <Composer
          label={copy.agent.goalLabel}
          placeholder={copy.agent.goalPlaceholder[mode]}
          streaming={false}
          blocked={guard}
          value={goal}
          onValueChange={setGoal}
          onSend={async (content) => {
            await planMission(content);
            return true;
          }}
          onStop={() => undefined}
        />
        {hasWorkspace ? <ContextInspector goal={goal} onGoalChange={setGoal} /> : null}
      </div>
    </div>
  );
}

function MissionPane() {
  const plan = useApp((state) => state.missions.plan);
  const mode = useApp((state) => state.workMode);
  const workspace = useApp((state) => state.workspace.current);
  const expert = useApp((state) => state.ui.displayMode === "expert");
  const startMission = useApp((state) => state.startMission);
  const discardPlan = useApp((state) => state.discardPlan);
  const planMission = useApp((state) => state.planMission);
  const openModelPicker = useApp((state) => state.openModelPicker);
  const webPreference = useApp((state) => state.missions.webPreference);
  const online = useOnline();
  const guard = useMissionGuard();
  const toast = useToast();

  if (plan.status === "planning") {
    return (
      <output className="nova-agent__planning">
        <span className="nova-agent-goal">{plan.goal}</span>
        <span>{online ? copy.agent.planning : copy.agent.planOffline}</span>
      </output>
    );
  }
  if (plan.status === "error" && !plan.result) {
    return (
      <Callout
        tone="danger"
        title={copy.agent.planFailed}
        action={
          <span className="nova-agent__actions">
            <Button size="sm" variant="secondary" onClick={() => void planMission(plan.goal)}>
              {copy.agent.retry}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => openModelPicker("conversation")}>
              {copy.agent.changeModel}
            </Button>
            <Button size="sm" variant="ghost" onClick={discardPlan}>
              {fr.app.cancel}
            </Button>
          </span>
        }
      >
        <p>{describeUiError(plan.error).title}</p>
      </Callout>
    );
  }
  if ((plan.status === "ready" || plan.status === "starting" || plan.status === "error") && plan.result && workspace) {
    const result = plan.result;
    return (
      <ContractSheet
        key={result.mission.id}
        result={result}
        workspacePath={workspace.displayPath}
        expert={expert}
        starting={plan.status === "starting"}
        error={plan.status === "error" ? plan.error : null}
        blocked={guard}
        webSearch={webPreference}
        onLaunch={(tasks, contract) => {
          startMission(result.mission.id, tasks, contract).catch((error: unknown) =>
            toast.show(errorToast(error, copy.contract.launchFailed)),
          );
        }}
        onCancel={discardPlan}
      />
    );
  }
  return <GoalComposer mode={mode === "discuss" ? "plan" : mode} />;
}

function SelectedMission({ view }: { view: MissionView | null }) {
  const status = useApp((state) => state.missions.detailStatus);
  const error = useApp((state) => state.missions.detailError);
  const selectedId = useApp((state) => state.missions.selectedId);
  const selectMission = useApp((state) => state.selectMission);
  if (view) return <MissionTimeline view={view} />;
  if (status === "error" && error) {
    return (
      <Callout
        tone="danger"
        title={copy.agent.missionLoadFailed}
        action={
          <Button size="sm" variant="secondary" onClick={() => selectMission(selectedId)}>
            {fr.app.retry}
          </Button>
        }
      >
        <p>{describeUiError(error).title}</p>
      </Callout>
    );
  }
  return (
    <div aria-busy="true" className="nova-agent__loading">
      <p className="nv-visually-hidden">{copy.agent.loadingMission}</p>
      <Skeleton height={32} />
      <Skeleton height={32} />
      <Skeleton height={32} />
    </div>
  );
}

/** Pending approvals from a stable slice (the list itself is derived per render). */
function usePendingApprovals() {
  const approvals = useApp((state) => state.approvals);
  return pendingApprovalList({ approvals });
}

function ApprovalReminder() {
  const pending = usePendingApprovals();
  const focusApproval = useApp((state) => state.focusApproval);
  const oldest = pending[0];
  if (!oldest) return null;
  return (
    <output className="nova-agent__reminder">
      <span>
        {copy.agent.approvalReminder}
        {pending.length > 1 ? ` · ${copy.statusBar.approvals(pending.length)}` : ""}
      </span>
      <Button size="sm" variant="ghost" onClick={() => focusApproval(oldest.id)} aria-keyshortcuts="Control+Shift+A Meta+Shift+A">
        {copy.agent.seeApproval}
      </Button>
    </output>
  );
}

/** Assertive announcement, once per approval (POWER_UX §6.3). */
function ApprovalAnnouncer() {
  const pending = usePendingApprovals();
  const announced = useRef(new Set<string>());
  const [message, setMessage] = useState<{ id: string; text: string } | null>(null);
  useEffect(() => {
    const fresh = pending.find((approval) => !announced.current.has(approval.id));
    if (!fresh) return;
    announced.current.add(fresh.id);
    const target = approvalTargetText(fresh);
    const title = `${copy.approval.title[fresh.request.operation]}${target ? ` ${target}` : ""}`;
    setMessage({ id: fresh.id, text: copy.approval.announce(title) });
  }, [pending]);
  return (
    <p className="nv-visually-hidden" aria-live="assertive">
      {message ? <span key={message.id}>{message.text}</span> : null}
    </p>
  );
}

export interface AgentPanelProps {
  /** Toggle of the workbench/context column, shown in the conversation header. */
  contextToggle: { open: boolean; toggle: () => void } | null;
}

export function AgentPanel({ contextToggle }: AgentPanelProps) {
  const view = useApp(selectedMissionView);
  const selectedId = useApp((state) => state.missions.selectedId);
  const mode = useApp((state) => state.workMode);
  const hasWorkspace = useApp((state) => state.workspace.current !== null);
  const online = useOnline();

  useEffect(() => installTypingTracker(), []);

  const showChat = selectedId === null && (mode === "discuss" || !hasWorkspace);
  return (
    <section className="nova-agent" data-agent-panel aria-label={copy.shell.agentLabel}>
      {showChat && !hasWorkspace ? null : <AgentHeader view={view} />}
      {hasWorkspace && selectedId === null ? <ModeBar /> : null}
      {!online && !showChat ? <Callout tone="info">{copy.shell.offline}</Callout> : null}
      <div className="nova-agent__body">
        {showChat ? <ChatView contextToggle={contextToggle} /> : selectedId ? <SelectedMission view={view} /> : <MissionPane />}
      </div>
      <ApprovalReminder />
      <ApprovalAnnouncer />
    </section>
  );
}
