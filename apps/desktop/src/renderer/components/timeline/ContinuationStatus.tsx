// L8 — what a mission card says about « jusqu'à preuve » (rounds in progress, or why the
// continuation stopped) and where a forked mission comes from. Pure over the mission view's
// continuation slice; renders nothing when there is nothing to say.
import { Button } from "@nova/ui";
import { CONTINUATION_STOP_COPY, timelineCopy } from "../../copy/fr-timeline";
import { continuationStatus, type ContinuationView } from "../missions/harness/continuation-view";
// oxlint-disable-next-line import/no-unassigned-import
import "./timeline.css";

const copy = timelineCopy;

export interface ContinuationStatusProps {
  view: ContinuationView;
  /** Opens the original of a forked mission; absent = no button. */
  onOpenMission?(missionId: string): void;
}

export function ContinuationStatus({ view, onOpenMission }: ContinuationStatusProps) {
  const status = continuationStatus(view);
  const origin = view.forkedFrom;
  if (status.kind === "none" && !origin) return null;
  return (
    <div className="nova-continuation">
      {origin ? (
        <p className="nova-note">
          {copy.forkOrigin.label(origin.seq)}{" "}
          {onOpenMission ? (
            <Button size="sm" variant="ghost" onClick={() => onOpenMission(origin.missionId)}>
              {copy.forkOrigin.open}
            </Button>
          ) : null}
        </p>
      ) : null}
      {status.kind === "running" ? (
        <p>
          <output>
            <strong>{copy.continuation.heading}</strong> · {copy.continuation.round(status.round, status.maxRounds)} ·{" "}
            {copy.continuation.unproven(status.unproven)}
          </output>
        </p>
      ) : null}
      {status.kind === "stopped" ? (
        <p>
          <output>
            <strong>{copy.continuation.heading}</strong> · {copy.continuation.stopped(CONTINUATION_STOP_COPY[status.reason].title, status.rounds)}
          </output>
          <span className="nova-note"> — {CONTINUATION_STOP_COPY[status.reason].detail}</span>
        </p>
      ) : null}
      {view.rounds.length > 1 ? (
        <ol className="nova-continuation__rounds" aria-label={copy.continuation.heading}>
          {view.rounds.map((round) => (
            <li key={round.seq}>
              {copy.continuation.round(round.round, round.maxRounds)} ({copy.continuation.unproven(round.unprovenTaskIds.length)})
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}
