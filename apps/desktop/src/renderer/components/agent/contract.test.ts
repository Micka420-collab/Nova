import { describe, expect, it } from "vitest";
import type { MissionPlanResult } from "@nova/shared";
import { makeContract } from "../../test/atelier-fake";
import {
  addStep,
  draftFromPlan,
  estimateExceedsCap,
  moveStep,
  parseDecimal,
  removeStep,
  updateStep,
  validateContractDraft,
} from "./contract";

const MISSION_ID = "00000000-0000-4000-8000-00000000c001";
const WORKSPACE_ID = "00000000-0000-4000-8000-00000000c002";

function plan(): MissionPlanResult {
  return {
    mission: {
      id: MISSION_ID,
      workspaceId: WORKSPACE_ID,
      conversationId: null,
      title: "Corriger",
      goal: "Corriger le panier",
      mode: "fix",
      state: "ready",
      modelId: "vendor/model",
      createdAt: 1,
      startedAt: null,
      endedAt: null,
      updatedAt: 1,
    },
    contract: makeContract(WORKSPACE_ID, { budgetUsd: 0.5, maxDurationMs: 10 * 60_000, allowedHosts: ["registry.npmjs.org"] }),
    tasks: [
      { id: "t2", missionId: MISSION_ID, seq: 2, title: "Corriger", state: "todo", acceptance: { kind: "manual", detail: "" } },
      {
        id: "t1",
        missionId: MISSION_ID,
        seq: 1,
        title: "Reproduire",
        state: "todo",
        acceptance: { kind: "test_passes", detail: "pnpm vitest run cart" },
      },
    ],
    summary: "Deux étapes",
    estimate: { minUsd: 0.05, maxUsd: 0.2, assumptions: "8 à 20 appels" },
  };
}

describe("contract sheet validation", () => {
  it("prefills from the plan in step order, with French decimals", () => {
    const draft = draftFromPlan(plan());
    expect(draft.steps.map((step) => step.title)).toEqual(["Reproduire", "Corriger"]);
    expect(draft.budgetUsd).toBe("0,5");
    expect(draft.durationMinutes).toBe("10");
    expect(draft.hostsText).toBe("registry.npmjs.org");
  });

  it("keeps the proposed plan (tasks null) when no step was edited", () => {
    const result = validateContractDraft(MISSION_ID, draftFromPlan(plan()));
    expect(result).toMatchObject({ ok: true, tasks: null });
    if (!result.ok) throw new Error("expected a valid draft");
    expect(result.contract).toEqual({
      profile: "assisted",
      allowedOperations: ["read", "write", "execute"],
      allowedHosts: ["registry.npmjs.org"],
      webSearch: false,
      maxDurationMs: 600_000,
      budgetUsd: 0.5,
    });
  });

  it("sends the edited plan once a step is reordered, removed or added", () => {
    let draft = draftFromPlan(plan());
    const [first, second] = draft.steps;
    if (!first || !second) throw new Error("two steps expected");
    draft = moveStep(draft, second.key, -1);
    draft = removeStep(draft, first.key);
    draft = addStep(draft, "Relancer toute la suite");
    const result = validateContractDraft(MISSION_ID, draft);
    if (!result.ok) throw new Error("expected a valid draft");
    expect(result.tasks).toEqual([
      { title: "Corriger", acceptance: { kind: "manual", detail: "" } },
      { title: "Relancer toute la suite", acceptance: { kind: "manual", detail: "" } },
    ]);
  });

  it("names every invalid field: empty step, budget, duration, host", () => {
    let draft = draftFromPlan(plan());
    const step = draft.steps[0];
    if (!step) throw new Error("step expected");
    draft = updateStep(draft, step.key, { title: "  " });
    draft = { ...draft, budgetUsd: "beaucoup", durationMinutes: "0", hostsText: "exemple.com\nhttp://evil.test/x" };
    const result = validateContractDraft(MISSION_ID, draft);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.stepTitles?.[step.key]).toBe("L'étape 1 n'a pas de titre.");
    expect(result.errors.budget).toMatch(/budget/);
    expect(result.errors.duration).toMatch(/durée/);
    expect(result.errors.hosts).toMatch(/http:\/\/evil\.test\/x/);
  });

  it("refuses an empty plan and more than 1 000 $", () => {
    let draft = draftFromPlan(plan());
    for (const step of draft.steps) draft = removeStep(draft, step.key);
    const result = validateContractDraft(MISSION_ID, { ...draft, budgetUsd: "1000,01" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.steps).toBe("Le plan doit contenir au moins une étape.");
    expect(result.errors.budget).toBeDefined();
  });

  it("keeps a cap below one cent as typed, and refuses a cap of 0 (a mission that can do nothing)", () => {
    const draft = draftFromPlan(plan());
    const small = validateContractDraft(MISSION_ID, { ...draft, budgetUsd: "0,002" });
    expect(small.ok && small.contract.budgetUsd).toBe(0.002);
    expect(validateContractDraft(MISSION_ID, { ...draft, budgetUsd: "0" })).toMatchObject({
      ok: false,
      errors: { budget: "Le budget doit être un montant supérieur à 0 $ et d'au plus 1 000 $." },
    });
  });

  it("lowercases and dedupes hosts, accepts wildcard subdomains", () => {
    const draft = { ...draftFromPlan(plan()), hostsText: "Docs.Example.com, *.npmjs.org docs.example.com" };
    const result = validateContractDraft(MISSION_ID, draft);
    if (!result.ok) throw new Error("expected a valid draft");
    expect(result.contract.allowedHosts).toEqual(["docs.example.com", "*.npmjs.org"]);
  });

  it("parses decimals strictly and compares the estimate with the cap", () => {
    expect(parseDecimal("0,75")).toBe(0.75);
    expect(parseDecimal("1e3")).toBeNull();
    expect(parseDecimal("-1")).toBeNull();
    expect(estimateExceedsCap({ minUsd: 0.8, maxUsd: 2.1, assumptions: "" }, "0,50")).toBe(true);
    expect(estimateExceedsCap({ minUsd: null, maxUsd: null, assumptions: "" }, "0,50")).toBe(false);
  });
});
