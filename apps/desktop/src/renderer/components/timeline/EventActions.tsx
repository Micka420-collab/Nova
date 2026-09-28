// L8 — « Reprendre d'ici » / « Bifurquer d'ici » on a stored event of a mission. Both prepare a
// NEW mission (`timeline.fork`: new plan, contract to accept, new approvals; nothing replayed, the
// original unchanged); « Bifurquer » also takes a new goal. The outcome is always visible: the
// mission ready (with a button to its plan) or the refusal. Nothing renders while main does not
// serve `timeline.*`, nor for a live event (seq 0 is not in the journal).
import { useState } from "react";
import { Button, Callout, TextArea } from "@nova/ui";
import type { MissionPlanResult } from "@nova/shared";
import { timelineCopy } from "../../copy/fr-timeline";
import { describeUiError } from "../../lib/errors";
import { forkKey } from "../../state/timeline-slice";
import { useTimelineAvailable, useTimelineSlice, useTimelineStore } from "./use-timeline-store";
// oxlint-disable-next-line import/no-unassigned-import
import "./timeline.css";

const copy = timelineCopy.fork;

export interface EventActionsProps {
  missionId: string;
  /** Stored seq of the event (≥ 1). */
  seq: number;
  /** Shows the prepared mission's plan and contract (the app's contract sheet). */
  onReady(result: MissionPlanResult): void;
}

export function EventActions({ missionId, seq, onReady }: EventActionsProps) {
  const available = useTimelineAvailable();
  const store = useTimelineStore();
  const fork = useTimelineSlice((state) => state.forks[forkKey(missionId, seq)] ?? null);
  const [mode, setMode] = useState<"resume" | "branch" | null>(null);
  const [goal, setGoal] = useState("");
  if (!available || seq < 1) return null;

  const confirm = async (): Promise<void> => {
    const trimmed = goal.trim();
    const result = await store.getState().fork({
      missionId,
      atSeq: seq,
      goal: mode === "branch" && trimmed ? trimmed.slice(0, 20_000) : null,
      modelId: null,
    });
    if (result) setMode(null);
  };
  const close = (): void => {
    setMode(null);
    setGoal("");
    if (fork?.status === "error") store.getState().dismissFork(missionId, seq);
  };

  if (fork?.status === "ready") {
    return (
      <Callout
        tone="success"
        action={
          <div className="nova-event-actions__buttons">
            <Button size="sm" variant="primary" onClick={() => onReady(fork.result)}>
              {copy.openReady}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => store.getState().dismissFork(missionId, seq)}>
              {copy.cancel}
            </Button>
          </div>
        }
      >
        <output>{copy.ready(fork.result.mission.title)}</output>
      </Callout>
    );
  }

  const preparing = fork?.status === "preparing";
  return (
    <div className="nova-event-actions">
      {mode === null ? (
        <div className="nova-event-actions__buttons">
          <Button size="sm" title={copy.resumeHint} onClick={() => setMode("resume")}>
            {copy.resume}
          </Button>
          <Button size="sm" title={copy.branchHint} onClick={() => setMode("branch")}>
            {copy.branch}
          </Button>
        </div>
      ) : (
        <fieldset className="nova-event-actions__form">
          <legend>{mode === "resume" ? copy.resume : copy.branch}</legend>
          <p className="nova-note">{mode === "resume" ? copy.resumeHint : copy.branchHint}</p>
          {mode === "branch" ? (
            <TextArea label={copy.goal} hint={copy.goalHint} value={goal} rows={3} maxLength={20_000} onChange={(event) => setGoal(event.target.value)} />
          ) : null}
          <p className="nova-note">{copy.noEffect}</p>
          <div className="nova-event-actions__buttons">
            <Button size="sm" variant="primary" loading={preparing} onClick={() => void confirm()}>
              {preparing ? copy.preparing : copy.confirm}
            </Button>
            <Button size="sm" variant="ghost" disabled={preparing} onClick={close}>
              {copy.cancel}
            </Button>
          </div>
        </fieldset>
      )}
      {fork?.status === "error" ? (
        <Callout tone="danger" title={copy.failed}>
          {describeUiError(fork.error).title}
        </Callout>
      ) : null}
    </div>
  );
}
