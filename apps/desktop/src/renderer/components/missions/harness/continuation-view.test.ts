import { describe, expect, it } from "vitest";
import type { MissionEvent } from "@nova/shared";
import { continuationStatus, initialContinuationView, reduceContinuationEvent, type ContinuationMissionEvent, type ContinuationView } from "./continuation-view";

const M = "00000000-0000-4000-8000-0000000000c1";
const base = (seq: number) => ({ id: `e${seq}`, missionId: M, seq, at: seq * 10 });

function replay(events: MissionEvent[]): ContinuationView {
  return events.reduce((view, event) => reduceContinuationEvent(view, event as ContinuationMissionEvent), initialContinuationView());
}

describe("continuation view", () => {
  it("projects rounds in order, ignores a replayed round, then the stop", () => {
    const round1: MissionEvent = { ...base(4), type: "continuation.round", round: 1, maxRounds: 3, unprovenTaskIds: ["t1", "t2"] };
    const round2: MissionEvent = { ...base(9), type: "continuation.round", round: 2, maxRounds: 3, unprovenTaskIds: ["t2"] };
    const running = replay([round1, round2, round1]);
    expect(running.rounds.map((round) => round.round)).toEqual([1, 2]);
    expect(continuationStatus(running)).toEqual({ kind: "running", round: 2, maxRounds: 3, unproven: 1 });
    const stopped = reduceContinuationEvent(running, { ...base(12), type: "continuation.stopped", reason: "proven", rounds: 2 });
    expect(continuationStatus(stopped)).toEqual({ kind: "stopped", reason: "proven", rounds: 2 });
  });

  it("says nothing without rounds, and keeps the fork origin", () => {
    expect(continuationStatus(initialContinuationView())).toEqual({ kind: "none" });
    const forked = replay([{ ...base(2), type: "mission.forked", fromMissionId: "00000000-0000-4000-8000-0000000000c0", fromSeq: 7 }]);
    expect(forked.forkedFrom).toEqual({ missionId: "00000000-0000-4000-8000-0000000000c0", seq: 7 });
    expect(continuationStatus(forked)).toEqual({ kind: "none" });
  });

  it("reports a stop without rounds (manual only)", () => {
    const view = replay([{ ...base(3), type: "continuation.stopped", reason: "manual_only", rounds: 0 }]);
    expect(continuationStatus(view)).toEqual({ kind: "stopped", reason: "manual_only", rounds: 0 });
  });
});
