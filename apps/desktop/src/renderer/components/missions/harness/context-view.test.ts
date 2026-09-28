// L2 slice of the mission view: every summary is kept with its latest status, handoffs and model
// switches accumulate, live usage replaces the previous one; replaying the journal gives the same view.
import { describe, expect, it } from "vitest";
import type { CompactionSummary, ContextUsage, HandoffDossier, Mission, MissionEvent } from "@nova/shared";
import { makeContract } from "../../../test/atelier-fake";
import { applyMissionEvent, type MissionView } from "../timeline";
import { initialContextView, reduceContextEvent } from "./context-view";

const MISSION_ID = "00000000-0000-4000-8000-00000000a101";
const mission: Mission = {
  id: MISSION_ID, workspaceId: "00000000-0000-4000-8000-00000000b101", conversationId: null, title: "Panier", goal: "Corriger le panier",
  mode: "fix", state: "running", modelId: "vendor/a", createdAt: 1, startedAt: 1, endedAt: null, updatedAt: 1,
};
const summary: CompactionSummary = {
  id: "00000000-0000-4000-8000-00000000c101", target: { kind: "mission", missionId: MISSION_ID }, kind: "compaction", reason: "proposed", status: "proposed",
  summary: "Le test du panier échoue sur les remises.", summarizerModelId: "vendor/a", fromModelId: null, toModelId: null, coveredUntilSeq: 3,
  tokensBefore: 900, tokensAfter: 120, pruned: [], costUsd: 0.002, createdAt: 10, decidedAt: null,
};
const usage: ContextUsage = {
  target: { kind: "mission", missionId: MISSION_ID }, modelId: "vendor/a", usedTokens: 850, contextLength: 1_000, ratio: 0.85,
  source: "provider_usage", proposalDue: true, measuredAt: 9,
};
const dossier: HandoffDossier = {
  summaryId: "00000000-0000-4000-8000-00000000c102", missionId: MISSION_ID, fromModelId: "vendor/a", toModelId: "vendor/b", goal: "Corriger le panier",
  done: [], remaining: ["Tests verts"], decisions: [], filesTouched: ["src/cart.ts"], openQuestions: [], createdAt: 20,
};

type Body<T> = T extends unknown ? Omit<T, "id" | "seq" | "at" | "missionId"> : never;
function events(bodies: Body<MissionEvent>[]): MissionEvent[] {
  return bodies.map((body, index) => ({ ...body, id: `e${index}`, missionId: MISSION_ID, seq: index + 1, at: index + 1 }) as MissionEvent);
}

describe("context view (L2)", () => {
  it("tracks a summary through proposal and dismissal without duplicating it", () => {
    let view = reduceContextEvent(initialContextView(), { id: "u", missionId: MISSION_ID, seq: 0, at: 9, type: "context.usage", usage });
    view = reduceContextEvent(view, { id: "p", missionId: MISSION_ID, seq: 2, at: 10, type: "compaction.proposed", summary });
    view = reduceContextEvent(view, { id: "d", missionId: MISSION_ID, seq: 3, at: 11, type: "compaction.dismissed", summaryId: summary.id });
    expect(view.usage).toEqual(usage);
    expect(view.summaries).toEqual([{ ...summary, status: "dismissed", decidedAt: 11 }]);
  });

  it("replays applied summaries, handoffs and model switches from the journal", () => {
    const applied = { ...summary, status: "applied" as const, decidedAt: 12 };
    const view = events([
      { type: "mission.created", mission, contract: makeContract(mission.workspaceId) },
      { type: "compaction.proposed", summary },
      { type: "compaction.applied", summary: applied },
      { type: "handoff.created", dossier },
      { type: "model.switched", fromModelId: "vendor/a", toModelId: "vendor/b", handoffSummaryId: dossier.summaryId },
    ]).reduce<MissionView | undefined>((current, event) => applyMissionEvent(current, event), undefined);
    expect(view?.harness.context.summaries).toEqual([applied]);
    expect(view?.harness.context.handoffs).toEqual([dossier]);
    expect(view?.harness.context.modelSwitches).toEqual([{ at: 5, fromModelId: "vendor/a", toModelId: "vendor/b", handoffSummaryId: dossier.summaryId }]);
    // Live usage is never replayed (not stored): unknown after a reload.
    expect(view?.harness.context.usage).toBeNull();
  });
});
