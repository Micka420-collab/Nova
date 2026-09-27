import { describe, expect, it } from "vitest";
import type { CompanionSignal, CompanionSignalKind } from "@nova/shared";
import { EMPTY_COMPANION_FACTS, reduceCompanionFacts, type CompanionFactsState } from "./facts";
import { formatClock } from "./format";
import { signalsFromMissionEvent } from "./signals";
import { rankSuggestions, suggestionForSignal } from "./suggestions";
import { MISSION_ID, MissionLog, approval, commandDisplay, testsDisplay } from "./test-events";

let counter = 0;
function signal(kind: CompanionSignalKind, sourceRef: CompanionSignal["sourceRef"], excerpt: string | null, createdAt = 5_000): CompanionSignal {
  counter += 1;
  return { id: `sig-${counter}`, kind, workspaceId: null, sourceRef, evidence: { excerpt, path: null }, state: "new", createdAt };
}

function factsOf(log: MissionLog): CompanionFactsState {
  return log.events.reduce(reduceCompanionFacts, EMPTY_COMPANION_FACTS);
}

const missionRef = { kind: "mission" as const, missionId: MISSION_ID };

describe("P6 suggestion rules", () => {
  const log = new MissionLog().created("Facturation").started();
  log.add("approval.requested", { approval: approval("appr-1") });
  log.add("budget.updated", {
    budget: { budgetUsd: 4, reservedUsd: 0, spentUsd: 4.1, unknownCostCalls: 0, dailySpentUsd: 4.1, dailyLimitUsd: 5 },
  });
  log.tool("call-1", "run_tests").finished("call-1", testsDisplay(41, 1, 1), "failed");
  log.tool("call-2", "run_command").finished("call-2", commandDisplay(["pnpm", "build"], 2, "error TS2345"), "failed");
  log.add("mission.suspended", { reason: "budget", detail: null });
  const facts = factsOf(log);

  it.each<[string, CompanionSignal, string, string]>([
    [
      "approval pending → open the approval card",
      signal("approval_pending", { kind: "approval", approvalId: "appr-1", missionId: MISSION_ID }, "exécuter pnpm install"),
      "Une mission attend ta réponse : exécuter pnpm install.",
      "open_approval",
    ],
    [
      "budget reached → stop (or raise the cap from the card)",
      signal("budget_reached", missionRef, "plafond de budget atteint"),
      "« Facturation » est suspendue au plafond (4,10 $ sur 4,00 $). Tu peux l'arrêter ou relever le plafond depuis sa carte.",
      "stop_mission",
    ],
    [
      "failed test → explain the error",
      signal("test_failed", { kind: "tool_call", toolCallId: "call-1", missionId: MISSION_ID }, " FAIL  src/cart.test.ts\n Tests  41 passed | 1 failed (42)"),
      `cart.test.ts échoue depuis ${formatClock(5_000)}.`,
      "explain_error",
    ],
    [
      "crashed command → explain the error, with the real command and exit code",
      signal("process_crashed", { kind: "tool_call", toolCallId: "call-2", missionId: MISSION_ID }, "error TS2345"),
      "La commande pnpm build s'est arrêtée (code 2).",
      "explain_error",
    ],
    [
      "failed mission → explain",
      signal("mission_failed", missionRef, "délai dépassé"),
      "« Facturation » a échoué : délai dépassé.",
      "explain_error",
    ],
  ])("%s", (_name, input, text, action) => {
    const draft = suggestionForSignal(input, facts.missions[MISSION_ID] ?? null);
    expect(draft).toMatchObject({ signalId: input.id, text, action: { type: action } });
  });

  it("a terminal signal without argv names the command as watched", () => {
    const draft = suggestionForSignal(signal("process_crashed", { kind: "terminal", sessionId: "s-1" }, "boom"), null);
    expect(draft?.text).toBe("La commande surveillée s'est arrêtée.");
  });

  it("ranks at most three, in P6 order then newest first, each carrying its signal id", () => {
    const signals = [
      signal("mission_done", missionRef, "ok", 9_000),
      signal("process_crashed", { kind: "tool_call", toolCallId: "call-2", missionId: MISSION_ID }, "x", 8_000),
      signal("test_failed", { kind: "tool_call", toolCallId: "call-1", missionId: MISSION_ID }, "x", 7_000),
      signal("approval_pending", { kind: "approval", approvalId: "appr-1", missionId: MISSION_ID }, "exécuter pnpm install", 1_000),
    ];
    const ranked = rankSuggestions(signals, facts, new Set());
    expect(ranked.map((draft) => draft.kind)).toEqual(["approval_pending", "test_failed", "process_crashed"]);
    for (const draft of ranked) expect(signals.map((s) => s.id)).toContain(draft.signalId);
  });

  it("no signal, no suggestion; muted kinds and ignored signals propose nothing", () => {
    expect(rankSuggestions([], facts, new Set())).toEqual([]);
    const failed = signal("mission_failed", missionRef, "x");
    expect(rankSuggestions([failed], facts, new Set(["mission_failed"]))).toEqual([]);
    expect(rankSuggestions([{ ...failed, state: "ignored" }], facts, new Set())).toEqual([]);
  });

  it("drops a suggestion once its fact is over (approval answered, failure fixed)", () => {
    const later = new MissionLog().created().started();
    later.add("approval.requested", { approval: approval("appr-2") });
    later.tool("call-9", "run_tests").finished("call-9", testsDisplay(3, 1, 1), "failed");
    let state = EMPTY_COMPANION_FACTS;
    const fromLog = later.events.flatMap((event) => {
      state = reduceCompanionFacts(state, event);
      return signalsFromMissionEvent(event, state.missions[MISSION_ID] ?? null);
    });
    const asSignals = fromLog.map((produced, index) => ({ ...produced.draft, id: `p-${index}`, state: "new" as const, createdAt: index }));
    expect(rankSuggestions(asSignals, factsOf(later), new Set()).map((d) => d.kind)).toEqual(["approval_pending", "test_failed"]);

    later.add("approval.resolved", { approval: { ...approval("appr-2"), status: "approved", scope: "once" } });
    later.tool("call-10", "run_tests").finished("call-10", testsDisplay(4, 0, 0));
    expect(rankSuggestions(asSignals, factsOf(later), new Set())).toEqual([]);
  });
});
