// Contract of a sub-mission: always a subset of its parent's (never wider), derived in main from
// the parent's live contract, never from the model's arguments beyond mode, goal and budget.
import { MODE_OPERATIONS } from "@nova/permissions";
import type { MissionContract, MissionContractInput, OperationClass, WorkMode } from "@nova/shared";

type Allowance = (typeof MODE_OPERATIONS)[WorkMode][OperationClass];

/** A child allowance fits under its parent's: refused by the child, identical, or the parent allows all. */
function fitsUnder(child: Allowance, parent: Allowance): boolean {
  return child === "no" || child === parent || parent === "yes";
}

/** Operations a writing child needs its own worktree for. */
const WRITE_OPERATIONS: readonly OperationClass[] = ["write", "delete"];

export type ChildContractOutcome =
  | { ok: true; input: MissionContractInput; writes: boolean }
  | { ok: false; reason: string };

/**
 * The child's contract input:
 * - operations: the parent's, minus those the child's mode refuses, minus every one the child's
 *   mode allows more broadly than the parent's mode does, minus `git_mutation` (a child's worktree
 *   is throwaway: its changes reach the project only through the integration, never as commits);
 * - hosts, web search, profile, duration: the parent's;
 * - budget: the amount reserved on the parent;
 * - J2-B options: no sub-missions (depth 1), no auto-continuation; Chaîne only if the parent has it.
 * A mode that would write while the parent's mode cannot is refused (not silently narrowed): the
 * model asked for something this mission may not delegate.
 */
export function childContractInput(parent: MissionContract, mode: Exclude<WorkMode, "discuss">, budgetUsd: number): ChildContractOutcome {
  const parentModes = MODE_OPERATIONS[parent.mode];
  const childModes = MODE_OPERATIONS[mode];
  for (const operation of WRITE_OPERATIONS) {
    if (childModes[operation] !== "no" && !fitsUnder(childModes[operation], parentModes[operation])) {
      return { ok: false, reason: `this mission (mode ${parent.mode}) cannot write, so it cannot delegate a ${mode} sub-mission` };
    }
  }
  const allowedOperations = parent.allowedOperations.filter(
    (operation) => operation !== "git_mutation" && childModes[operation] !== "no" && fitsUnder(childModes[operation], parentModes[operation]),
  );
  const writes = allowedOperations.some((operation) => WRITE_OPERATIONS.includes(operation) && childModes[operation] !== "no");
  const chain = parent.harness?.chain ?? false;
  return {
    ok: true,
    writes,
    input: {
      profile: parent.profile,
      allowedOperations,
      allowedHosts: [...parent.allowedHosts],
      webSearch: parent.webSearch,
      maxDurationMs: parent.maxDurationMs,
      budgetUsd,
      harness: { chain, autoContinue: null, subMissions: null },
    },
  };
}

/** True when `child` grants nothing `parent` does not (used by tests and as a last check). */
export function isNarrowerContract(child: MissionContractInput & { mode: WorkMode }, parent: MissionContract): boolean {
  const parentModes = MODE_OPERATIONS[parent.mode];
  const childModes = MODE_OPERATIONS[child.mode];
  const operationsFit = child.allowedOperations.every(
    (operation) => parent.allowedOperations.includes(operation) && fitsUnder(childModes[operation], parentModes[operation]),
  );
  const hostsFit = child.allowedHosts.every((host) => parent.allowedHosts.includes(host));
  const harness = child.harness;
  const harnessFits = !harness || (harness.subMissions === null && harness.autoContinue === null && (!harness.chain || parent.harness?.chain === true));
  return (
    operationsFit &&
    hostsFit &&
    harnessFits &&
    (!child.webSearch || parent.webSearch) &&
    child.profile === parent.profile &&
    child.maxDurationMs <= parent.maxDurationMs &&
    child.budgetUsd <= parent.budgetUsd
  );
}
