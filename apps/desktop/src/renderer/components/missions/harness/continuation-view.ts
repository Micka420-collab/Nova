// L8 — timeline projection of auto-continuation rounds and of the fork origin of a mission.
// Owned by lane L8 (J2-B lane map). Pure: same events → same view (a replayed event is ignored).
import type { ContinuationStopReason, HarnessMissionEvent } from "@nova/shared";

export interface ContinuationRound {
  seq: number;
  round: number;
  maxRounds: number;
  unprovenTaskIds: string[];
  at: number;
}

export interface ContinuationView {
  rounds: ContinuationRound[];
  stopped: { reason: ContinuationStopReason; rounds: number; at: number } | null;
  forkedFrom: { missionId: string; seq: number } | null;
}

export type ContinuationMissionEvent = Extract<
  HarnessMissionEvent,
  { type: "continuation.round" | "continuation.stopped" | "mission.forked" }
>;

export function initialContinuationView(): ContinuationView {
  return { rounds: [], stopped: null, forkedFrom: null };
}

export function reduceContinuationEvent(view: ContinuationView, event: ContinuationMissionEvent): ContinuationView {
  switch (event.type) {
    case "continuation.round":
      if (view.rounds.some((round) => round.seq === event.seq)) return view;
      return {
        ...view,
        rounds: [...view.rounds, { seq: event.seq, round: event.round, maxRounds: event.maxRounds, unprovenTaskIds: event.unprovenTaskIds, at: event.at }].sort(
          (a, b) => a.seq - b.seq,
        ),
      };
    case "continuation.stopped":
      return { ...view, stopped: { reason: event.reason, rounds: event.rounds, at: event.at } };
    case "mission.forked":
      return { ...view, forkedFrom: { missionId: event.fromMissionId, seq: event.fromSeq } };
  }
}

/** What the mission card says about « jusqu'à preuve »: nothing, rounds in progress, or why it stopped. */
export type ContinuationStatus =
  | { kind: "none" }
  | { kind: "running"; round: number; maxRounds: number; unproven: number }
  | { kind: "stopped"; reason: ContinuationStopReason; rounds: number };

export function continuationStatus(view: ContinuationView): ContinuationStatus {
  if (view.stopped) return { kind: "stopped", reason: view.stopped.reason, rounds: view.stopped.rounds };
  const last = view.rounds.at(-1);
  if (!last) return { kind: "none" };
  return { kind: "running", round: last.round, maxRounds: last.maxRounds, unproven: last.unprovenTaskIds.length };
}
