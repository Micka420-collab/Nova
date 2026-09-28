// L8 — timeline projection of auto-continuation rounds and of the fork origin of a mission.
// Owned by lane L8 (J2-B lane map). Pure: same events → same view.
import type { ContinuationStopReason, HarnessMissionEvent } from "@nova/shared";

export interface ContinuationView {
  rounds: { round: number; maxRounds: number; unprovenTaskIds: string[]; at: number }[];
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
      return {
        ...view,
        rounds: [...view.rounds, { round: event.round, maxRounds: event.maxRounds, unprovenTaskIds: event.unprovenTaskIds, at: event.at }],
      };
    case "continuation.stopped":
      return { ...view, stopped: { reason: event.reason, rounds: event.rounds, at: event.at } };
    case "mission.forked":
      return { ...view, forkedFrom: { missionId: event.fromMissionId, seq: event.fromSeq } };
  }
}
