// Sub-missions of a mission (L5): the parent/children tree shown in the mission card, with each
// child's live state, what it reserved, and where its changes stand (« Intégrer », « Abandonner »,
// integration state and what it means for the project). A child's own card shows its parent.
// Data comes from main (`submissions.tree`), kept current by mission events through the store; a
// group that answers `unavailable` (not wired) shows nothing at all (no inert control). Every
// action ends in a visible outcome: the new integration state, or an error on the row.
import { useEffect, useState } from "react";
import { useStore } from "zustand";
import { Button, Callout, StatusPill, type BadgeTone } from "@nova/ui";
import type { MissionTreeNode, SubMissionIntegration } from "@nova/shared";
import { MISSION_STATE_LABELS } from "../../copy/fr-atelier";
import { SUBMISSION_INTEGRATION_HINTS, SUBMISSION_INTEGRATION_LABELS, submissionErrorText, submissionsCopy } from "../../copy/fr-submissions";
import { formatCost } from "../../lib/format";
import { canDiscard, canIntegrate, type SubmissionsStore } from "../../state/submissions-slice";
// Side-effect import: the tree's stylesheet ships with the component (emitted as a file, CSP-safe).
// oxlint-disable-next-line import/no-unassigned-import
import "./submissions.css";

const copy = submissionsCopy.tree;

export interface SubmissionTreeProps {
  store: SubmissionsStore;
  missionId: string;
  /** Opens a mission (child or parent) in the workbench; absent = no « Ouvrir » button. */
  onOpenMission?(missionId: string): void;
}

type Child = MissionTreeNode["children"][number];

const INTEGRATION_TONES: Record<SubMissionIntegration, BadgeTone> = {
  not_needed: "neutral",
  pending: "amber",
  testing: "amber",
  integrated: "jade",
  tests_failed: "danger",
  conflict: "danger",
  discarded: "neutral",
};

function missionTone(state: Child["mission"]["state"]): BadgeTone {
  if (state === "succeeded") return "jade";
  if (state === "failed") return "danger";
  if (state === "waiting_approval" || state === "suspended") return "amber";
  return "neutral";
}

function ChildRow({ child, store, onOpenMission }: { child: Child; store: SubmissionsStore; onOpenMission?: (id: string) => void }) {
  const busy = useStore(store, (state) => state.busy[child.mission.id] ?? null);
  const error = useStore(store, (state) => state.errors[child.mission.id] ?? null);
  const [confirming, setConfirming] = useState(false);
  const { mission, link } = child;
  const reserved = formatCost(link.reservedUsd);
  const running = mission.state === "running" || mission.state === "waiting_approval";
  const integration = link.integration;
  const hint = integration ? SUBMISSION_INTEGRATION_HINTS[integration] : null;
  const writes = link.worktree !== null || (integration !== null && integration !== "not_needed");

  const discard = async (): Promise<void> => {
    setConfirming(false);
    await store.getState().discard(mission.id);
  };

  return (
    <li className="nova-subs__child" aria-busy={busy !== null}>
      <div className="nova-subs__line">
        <span className="nova-subs__name">{mission.title}</span>
        <StatusPill tone={missionTone(mission.state)} active={running}>
          {copy.childState(MISSION_STATE_LABELS[mission.state])}
        </StatusPill>
        {integration ? (
          <StatusPill tone={INTEGRATION_TONES[integration]} active={integration === "testing"}>
            {SUBMISSION_INTEGRATION_LABELS[integration]}
          </StatusPill>
        ) : null}
      </div>
      <p className="nova-subs__meta">
        {reserved ? copy.reserved(reserved) : copy.reservedUnknown} · {writes ? copy.writes : copy.readOnly}
        {integration === null && writes ? ` · ${copy.integrationRunning}` : ""}
      </p>
      {hint ? <p className="nova-subs__hint">{hint}</p> : null}
      {error ? (
        <p className="nova-subs__error" role="alert">
          {submissionErrorText(error.action, error.code)}
        </p>
      ) : null}
      <div className="nova-subs__actions">
        {onOpenMission ? (
          <Button size="sm" variant="ghost" aria-label={copy.openLabel(mission.title)} onClick={() => onOpenMission(mission.id)}>
            {copy.open}
          </Button>
        ) : null}
        {canIntegrate(child) ? (
          <Button
            size="sm"
            variant="primary"
            aria-label={copy.integrateLabel(mission.title)}
            loading={busy === "integrating"}
            disabled={busy !== null}
            onClick={() => void store.getState().integrate(mission.id)}
          >
            {integration === "pending" ? copy.integrate : copy.retry}
          </Button>
        ) : null}
        {canDiscard(child) && !confirming ? (
          <Button size="sm" aria-label={copy.discardLabel(mission.title)} loading={busy === "discarding"} disabled={busy !== null} onClick={() => setConfirming(true)}>
            {copy.discard}
          </Button>
        ) : null}
      </div>
      {confirming ? (
        <div className="nova-subs__confirm">
          <p className="nova-subs__hint">{copy.discardConfirm}</p>
          <div className="nova-subs__actions">
            <Button size="sm" variant="danger" onClick={() => void discard()}>
              {copy.discard}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
              {copy.cancel}
            </Button>
          </div>
        </div>
      ) : null}
    </li>
  );
}

export function SubmissionTree({ store, missionId, onOpenMission }: SubmissionTreeProps) {
  const availability = useStore(store, (state) => state.availability);
  const tree = useStore(store, (state) => state.trees[missionId] ?? null);
  const failed = useStore(store, (state) => state.loadFailed[missionId] === true);

  useEffect(() => {
    void store.getState().load(missionId);
  }, [store, missionId]);

  if (availability === "unavailable") return null;
  if (!tree) {
    if (!failed) return null;
    return (
      <Callout tone="danger" className="nova-subs" action={<Button size="sm" onClick={() => void store.getState().load(missionId)}>{copy.retryLoad}</Button>}>
        {copy.loadFailed}
      </Callout>
    );
  }

  // A sub-mission's own card: where it comes from.
  if (tree.link?.kind === "submission") {
    const parentId = tree.link.parentMissionId;
    return (
      <p className="nova-subs__parent">
        {copy.parent}{" "}
        {onOpenMission ? (
          <Button size="sm" variant="ghost" onClick={() => onOpenMission(parentId)}>
            {copy.openParent}
          </Button>
        ) : null}
      </p>
    );
  }

  // No child: no empty section in the mission card.
  if (tree.children.length === 0) return null;
  return (
    <section className="nova-subs" aria-label={copy.region}>
      <h3 className="nova-subs__title">{copy.title(tree.children.length)}</h3>
      <ul className="nova-subs__list">
        {tree.children.map((child) => (
          <ChildRow key={child.mission.id} child={child} store={store} {...(onOpenMission ? { onOpenMission } : {})} />
        ))}
      </ul>
    </section>
  );
}
