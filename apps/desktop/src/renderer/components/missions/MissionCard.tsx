// Mission card, a workbench document (VISUAL.md §4.6, FEATURES A9): header with state, step, cost
// and duration; steps as nodes (arrow keys move between them); an inspector of recorded facts only;
// the budget card and the cost report (Mo6).
import { useRef, useState, type KeyboardEvent } from "react";
import {
  BudgetMeter,
  Button,
  Callout,
  EmptyState,
  MissionNode,
  OrbitIndicator,
  Skeleton,
  StatusPill,
  type MissionNodeStatus,
} from "@nova/ui";
import type { MissionTask, MissionTaskState } from "@nova/shared";
import { fr } from "../../copy/fr";
import { ACCEPTANCE_LABELS, MISSION_STATE_LABELS, SUSPEND_REASON_COPY, TASK_STATE_LABELS } from "../../copy/fr-atelier";
import { describeUiError } from "../../lib/errors";
import { useNow } from "../../lib/hooks";
import { useApp } from "../../state/context";
import { budgetFormat, MISSION_STATE_TONES } from "../agent/AgentPanel";
import { EndCard, formatElapsed, observedCostLine } from "../agent/EndCard";
import { formatDurationMs } from "../agent/ToolCard";
import { currentTaskIndex, isMissionActive, missionFacts, type MissionView, type ToolItem } from "./timeline";

const copy = fr.atelier;

function nodeStatus(task: MissionTask, view: MissionView): MissionNodeStatus {
  const waiting = view.mission.state === "waiting_approval" && task.state === "running";
  if (waiting) return "waiting";
  if (view.mission.state === "suspended" && task.state === "running") return "suspended";
  const map: Record<MissionTaskState, MissionNodeStatus> = {
    todo: view.mission.state === "cancelled" ? "cancelled" : "ready",
    running: "running",
    verified: "succeeded",
    failed: "failed",
    blocked: "waiting",
    skipped: "skipped",
  };
  return map[task.state];
}

function toolsOfTask(view: MissionView, taskId: string): ToolItem[] {
  return view.items.filter((item): item is ToolItem => item.kind === "tool" && item.taskId === taskId);
}

function nodeFacts(view: MissionView, task: MissionTask): string {
  const tools = toolsOfTask(view, task.id);
  const files = new Set(tools.flatMap((item) => (item.display?.kind === "file_change" ? [item.display.path] : [])));
  const command = tools.findLast((item) => item.display?.kind === "command" || item.display?.kind === "tests");
  if (files.size === 1) return [...files][0] ?? "";
  if (files.size > 1) return copy.timeline.files(files.size);
  if (command?.call.argv) return command.call.argv.join(" ");
  return ACCEPTANCE_LABELS[task.acceptance.kind];
}

function Inspector({ view, task }: { view: MissionView; task: MissionTask | null }) {
  const openDoc = useApp((state) => state.openDoc);
  const selectMission = useApp((state) => state.selectMission);
  const setUi = useApp((state) => state.setUi);
  if (!task) return <p className="nova-note">{copy.mission.inspectorEmpty}</p>;
  const tools = toolsOfTask(view, task.id);
  const files = [...new Set(tools.flatMap((item) => (item.display?.kind === "file_change" ? [item.display.path] : [])))];
  const proofs = view.proofs.filter((proof) => proof.taskId === task.id);
  return (
    <div className="nova-mcard__inspector-body">
      <h3 className="nova-mcard__inspector-title">
        {copy.plan.stepTitle(task.seq)} — {task.title}
      </h3>
      <dl className="nova-facts">
        <dt>{copy.mission.status}</dt>
        <dd>{TASK_STATE_LABELS[task.state]}</dd>
        <dt>{copy.mission.acceptance}</dt>
        <dd>
          {ACCEPTANCE_LABELS[task.acceptance.kind]}
          {task.acceptance.detail ? <code>{task.acceptance.detail}</code> : null}
        </dd>
        <dt>{copy.mission.files}</dt>
        <dd>{files.length > 0 ? files.map((path) => <code key={path}>{path}</code>) : copy.mission.none}</dd>
        <dt>{copy.mission.proofs}</dt>
        <dd>{proofs.length > 0 ? proofs.map((proof) => <span key={proof.id}>{proof.summary}</span>) : copy.mission.none}</dd>
        <dt>{copy.mission.tools}</dt>
        <dd>
          {tools.length > 0
            ? tools.map((item) => (
                <span key={item.id}>
                  <code>{item.call.name}</code> · {copy.timeline.status[item.state]}
                  {formatDurationMs(item.durationMs) ? ` · ${formatDurationMs(item.durationMs)}` : ""}
                </span>
              ))
            : copy.mission.none}
        </dd>
      </dl>
      <div className="nova-mcard__inspector-actions">
        {files.length > 0 ? (
          <Button size="sm" variant="secondary" onClick={() => openDoc({ kind: "diff", missionId: view.mission.id })}>
            {copy.mission.openDiff}
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            selectMission(view.mission.id);
            setUi({ route: "chat", agentOpen: true });
          }}
        >
          {copy.mission.openJournal}
        </Button>
      </div>
    </div>
  );
}

function MissionMap({ view, selected, onSelect }: { view: MissionView; selected: string | null; onSelect: (id: string) => void }) {
  const nodes = useRef(new Map<string, HTMLButtonElement>());
  const current = currentTaskIndex(view);
  const running = view.mission.state === "running";
  const move = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const delta =
      event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
    const target = event.key === "Home" ? 0 : event.key === "End" ? view.tasks.length - 1 : index + delta;
    if ((delta === 0 && event.key !== "Home" && event.key !== "End") || target < 0 || target >= view.tasks.length) return;
    event.preventDefault();
    const task = view.tasks[target];
    if (!task) return;
    onSelect(task.id);
    nodes.current.get(task.id)?.focus();
  };
  const focusKey = selected ?? view.tasks[current ?? 0]?.id ?? null;
  return (
    <ol className="nova-mcard__map" aria-label={copy.mission.mapLabel}>
      {view.tasks.map((task, index) => {
        const status = nodeStatus(task, view);
        return (
          <li key={task.id} className="nova-mcard__node">
            <MissionNode
              ref={(element: HTMLButtonElement | null) => {
                if (element) nodes.current.set(task.id, element);
                else nodes.current.delete(task.id);
              }}
              index={index + 1}
              title={task.title}
              facts={nodeFacts(view, task)}
              status={status}
              statusLabel={TASK_STATE_LABELS[task.state]}
              accessibleName={copy.mission.stepAccessible(index + 1, task.title, TASK_STATE_LABELS[task.state])}
              selected={selected === task.id}
              // The header already spins while the mission runs: the node shows its state statically.
              orbit={!running && status === "running"}
              tabIndex={focusKey === task.id ? 0 : -1}
              onSelect={() => onSelect(task.id)}
              onKeyDown={(event) => move(event, index)}
            />
          </li>
        );
      })}
    </ol>
  );
}

export function MissionCard({ missionId }: { missionId: string }) {
  const view = useApp((state) => state.missions.views[missionId] ?? null);
  const status = useApp((state) => state.missions.detailStatus);
  const error = useApp((state) => state.missions.detailError);
  const selectMission = useApp((state) => state.selectMission);
  const openDoc = useApp((state) => state.openDoc);
  const setUi = useApp((state) => state.setUi);
  const [selected, setSelected] = useState<string | null>(null);
  const now = useNow(1_000);

  if (!view) {
    if (status === "error" && error) {
      return (
        <Callout
          tone="danger"
          title={copy.agent.missionLoadFailed}
          action={
            <Button size="sm" variant="secondary" onClick={() => selectMission(missionId)}>
              {fr.app.retry}
            </Button>
          }
        >
          <p>{describeUiError(error).title}</p>
        </Callout>
      );
    }
    return (
      <div className="nova-mcard" aria-busy="true">
        <p className="nv-visually-hidden">{copy.agent.loadingMission}</p>
        <div className="nova-mcard__map">
          <Skeleton width={220} height={64} radius={12} />
          <Skeleton width={220} height={64} radius={12} />
          <Skeleton width={220} height={64} radius={12} />
        </div>
      </div>
    );
  }

  const { mission } = view;
  const current = currentTaskIndex(view);
  const facts = missionFacts(view);
  const started = mission.startedAt;
  const elapsed = started === null ? null : formatElapsed((mission.endedAt ?? now) - started);
  const selectedTask = view.tasks.find((task) => task.id === selected) ?? null;
  const suspended = view.suspended && mission.state === "suspended" ? SUSPEND_REASON_COPY[view.suspended.reason] : null;

  return (
    <article className="nova-mcard" aria-labelledby={`mcard-${mission.id}`}>
      <header className="nova-mcard__header">
        <h2 id={`mcard-${mission.id}`} className="nova-mcard__title">
          {copy.mission.heading(mission.title)}
        </h2>
        <StatusPill tone={MISSION_STATE_TONES[mission.state]}>
          {mission.state === "running" ? <OrbitIndicator active size={12} /> : null}
          {MISSION_STATE_LABELS[mission.state]}
        </StatusPill>
        {current !== null && view.tasks.length > 0 ? (
          <span className="nova-mcard__meta">{copy.mission.step(current + 1, view.tasks.length)}</span>
        ) : null}
        <span className="nova-mcard__meta">{observedCostLine(view)}</span>
        {elapsed ? <span className="nova-mcard__meta">{elapsed}</span> : null}
        <span className="nova-mcard__actions">
          {isMissionActive(view) ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                selectMission(mission.id);
                // The journal is the agent panel: show it (closing the narrow overlay that hides it).
                setUi({ route: "chat", agentOpen: true, contextOverlayOpen: false });
              }}
            >
              {copy.mission.openJournal}
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" onClick={() => openDoc({ kind: "checkpoints", missionId: mission.id })}>
            {copy.mission.checkpoints}
          </Button>
        </span>
      </header>
      {suspended ? (
        <Callout tone="warning" title={suspended.title} className="nova-mcard__banner">
          <p>{view.suspended?.detail ?? suspended.detail}</p>
        </Callout>
      ) : null}
      <div className="nova-mcard__layout">
        <div className="nova-mcard__main">
          {view.tasks.length > 0 ? (
            <MissionMap view={view} selected={selected} onSelect={setSelected} />
          ) : (
            <EmptyState title={copy.mission.noSteps} description={copy.mission.noStepsBody} headingLevel={3} />
          )}
          {view.budget ? (
            <div className="nova-mcard__budget">
              <BudgetMeter
                variant="card"
                spentUsd={view.budget.spentUsd}
                reservedUsd={view.budget.reservedUsd}
                capUsd={view.budget.budgetUsd}
                unknownCostCalls={view.budget.unknownCostCalls}
                format={budgetFormat}
                labels={copy.budget}
                suspended={mission.state === "suspended"}
              />
            </div>
          ) : null}
          <p className="nova-note">
            {facts.partial ? `${copy.end.logCut} ` : ""}
            {copy.end.counts(facts.created, facts.modified, facts.deleted, facts.moved)}
            {facts.commands > 0 ? ` · ${copy.end.commands(facts.commands)}` : ""}
          </p>
          <EndCard view={view} />
        </div>
        <aside className="nova-mcard__inspector" aria-label={copy.mission.inspector}>
          <Inspector view={view} task={selectedTask} />
        </aside>
      </div>
    </article>
  );
}
