// Contract sheet model (A9/A13, UX.md §7.1): the plan and contract as the user edits them before
// launch, and their validation into a `missions.start` request. Pure: tested without a DOM.
import {
  HostPatternSchema,
  MissionStartRequestSchema,
  type AcceptanceKind,
  type MissionContractInput,
  type MissionPlanResult,
  type MissionTaskDraft,
  type OperationClass,
  type PermissionProfile,
} from "@nova/shared";
import { atelierCopy } from "../../copy/fr-atelier";

export const MAX_PLAN_STEPS = 50;
export const MAX_HOSTS = 100;
const MIN_DURATION_MIN = 1;
const MAX_DURATION_MIN = 24 * 60;
const MAX_BUDGET_USD = 1_000;

export interface StepDraft {
  /** Stable key for React lists and edits (not sent to main). */
  key: string;
  title: string;
  acceptanceKind: AcceptanceKind;
  acceptanceDetail: string;
}

export interface ContractDraft {
  steps: StepDraft[];
  /** The user reordered, removed, added or rewrote a step: the edited plan is sent, else null. */
  stepsEdited: boolean;
  profile: PermissionProfile;
  allowedOperations: OperationClass[];
  /** One host pattern per line (or separated by commas/spaces). */
  hostsText: string;
  webSearch: boolean;
  /** Text inputs keep what the user typed (French decimal comma accepted). */
  durationMinutes: string;
  budgetUsd: string;
}

export interface ContractErrors {
  steps?: string;
  stepTitles?: Record<string, string>;
  duration?: string;
  budget?: string;
  hosts?: string;
}

export type ContractValidation =
  | { ok: true; tasks: MissionTaskDraft[] | null; contract: MissionContractInput }
  | { ok: false; errors: ContractErrors };

let stepCounter = 0;
export function newStepKey(): string {
  stepCounter += 1;
  return `step-${stepCounter}`;
}

function formatNumberInput(value: number): string {
  return String(value).replace(".", ",");
}

export function draftFromPlan(result: MissionPlanResult): ContractDraft {
  const { contract } = result;
  return {
    steps: result.tasks
      .toSorted((a, b) => a.seq - b.seq)
      .map((task) => ({
        key: newStepKey(),
        title: task.title,
        acceptanceKind: task.acceptance.kind,
        acceptanceDetail: task.acceptance.detail,
      })),
    stepsEdited: false,
    profile: contract.profile,
    allowedOperations: [...contract.allowedOperations],
    hostsText: contract.allowedHosts.join("\n"),
    webSearch: contract.webSearch,
    durationMinutes: formatNumberInput(Math.round(contract.maxDurationMs / 60_000)),
    budgetUsd: formatNumberInput(contract.budgetUsd),
  };
}

/** Parses "0,50", "0.5", " 2 " as numbers; null when it is not a plain decimal number. */
export function parseDecimal(text: string): number | null {
  const normalized = text.trim().replace(/\s/g, "").replace(",", ".");
  if (!/^\d+(\.\d+)?$/.test(normalized)) return null;
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

export function parseHosts(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[\s,;]+/)
        .map((host) => host.trim().toLowerCase())
        .filter((host) => host.length > 0),
    ),
  ];
}

const copy = atelierCopy.contract.errors;

/** Validates the draft into what `missions.start` accepts; errors are French, one per field. */
export function validateContractDraft(missionId: string, draft: ContractDraft): ContractValidation {
  const errors: ContractErrors = {};

  if (draft.steps.length === 0) errors.steps = copy.noSteps;
  else if (draft.steps.length > MAX_PLAN_STEPS) errors.steps = copy.tooManySteps;
  const stepTitles: Record<string, string> = {};
  draft.steps.forEach((step, index) => {
    if (step.title.trim() === "") stepTitles[step.key] = copy.emptyStep(index + 1);
  });
  if (Object.keys(stepTitles).length > 0) errors.stepTitles = stepTitles;

  const minutes = parseDecimal(draft.durationMinutes);
  if (minutes === null || !Number.isInteger(minutes) || minutes < MIN_DURATION_MIN || minutes > MAX_DURATION_MIN) {
    errors.duration = copy.duration;
  }
  const budget = parseDecimal(draft.budgetUsd);
  if (budget === null || budget < 0 || budget > MAX_BUDGET_USD) errors.budget = copy.budget;

  const hosts = parseHosts(draft.hostsText);
  const invalidHost = hosts.find((host) => !HostPatternSchema.safeParse(host).success);
  if (invalidHost !== undefined) errors.hosts = copy.host(invalidHost);
  else if (hosts.length > MAX_HOSTS) errors.hosts = copy.tooManyHosts;

  if (Object.keys(errors).length > 0 || minutes === null || budget === null) return { ok: false, errors };

  const tasks: MissionTaskDraft[] | null = draft.stepsEdited
    ? draft.steps.map((step) => ({
        title: step.title.trim(),
        acceptance: { kind: step.acceptanceKind, detail: step.acceptanceDetail.trim() },
      }))
    : null;
  const contract: MissionContractInput = {
    profile: draft.profile,
    allowedOperations: draft.allowedOperations,
    allowedHosts: hosts,
    webSearch: draft.webSearch,
    maxDurationMs: Math.round(minutes) * 60_000,
    budgetUsd: Math.round(budget * 100) / 100,
  };
  // Same schema main applies: what passes here is exactly what main will accept.
  const parsed = MissionStartRequestSchema.safeParse({ missionId, tasks, contract });
  if (!parsed.success) {
    const field = String(parsed.error.issues[0]?.path[0] ?? "");
    return { ok: false, errors: field === "tasks" ? { steps: copy.noSteps } : { budget: copy.budget } };
  }
  return { ok: true, tasks, contract };
}

// Step edits (each marks the plan as edited).

export function updateStep(draft: ContractDraft, key: string, patch: Partial<Omit<StepDraft, "key">>): ContractDraft {
  return { ...draft, stepsEdited: true, steps: draft.steps.map((step) => (step.key === key ? { ...step, ...patch } : step)) };
}

export function moveStep(draft: ContractDraft, key: string, offset: -1 | 1): ContractDraft {
  const index = draft.steps.findIndex((step) => step.key === key);
  const target = index + offset;
  if (index === -1 || target < 0 || target >= draft.steps.length) return draft;
  const steps = [...draft.steps];
  const [moved] = steps.splice(index, 1);
  if (!moved) return draft;
  steps.splice(target, 0, moved);
  return { ...draft, stepsEdited: true, steps };
}

export function removeStep(draft: ContractDraft, key: string): ContractDraft {
  return { ...draft, stepsEdited: true, steps: draft.steps.filter((step) => step.key !== key) };
}

export function addStep(draft: ContractDraft, title: string): ContractDraft {
  const step: StepDraft = { key: newStepKey(), title, acceptanceKind: "manual", acceptanceDetail: "" };
  return { ...draft, stepsEdited: true, steps: [...draft.steps, step] };
}

/** Estimate above the cap (lower bound compared): the sheet warns before launch. */
export function estimateExceedsCap(estimate: MissionPlanResult["estimate"], budgetText: string): boolean {
  const cap = parseDecimal(budgetText);
  return cap !== null && estimate.minUsd !== null && estimate.minUsd > cap;
}
