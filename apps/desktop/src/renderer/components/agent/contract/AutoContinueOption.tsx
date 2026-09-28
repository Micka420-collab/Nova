// L8 — « Jusqu'à preuve » switch of the mission contract (MissionContract.harness.autoContinue):
// what it does, its two bounds (rounds, spend cap inside the mission budget) and when it would do
// nothing (only criteria to confirm by you). Off by default. Rendered only when the mission's mode
// runs tools. Owned by L8; mounted by ContractSheet, which blocks the launch while `error` is set.
import { useEffect, useMemo, useRef, useState } from "react";
import { Switch, TextField } from "@nova/ui";
import { AUTO_CONTINUE_LIMITS, type AcceptanceKind, type AutoContinueOptions, type WorkMode } from "@nova/shared";
import { timelineCopy } from "../../../copy/fr-timeline";
import { formatCost } from "../../../lib/format";
import { parseDecimal } from "../contract";

const copy = timelineCopy.option;

export const DEFAULT_AUTO_CONTINUE_ROUNDS = 3;

export interface AutoContinueChange {
  value: AutoContinueOptions | null;
  /** French message when the fields are invalid (then `value` is null and the launch waits). */
  error: string | null;
}

/**
 * Default bounds when the option is turned on: 3 rounds, half of the mission budget rounded down
 * to the cent, or to 0,0001 $ under a cent (a cheap mission's budget of 0,015 $ gives 0,0075 $,
 * not a 0 $ cap that would never allow a round). Without a valid mission budget: 0, refused below.
 */
export function defaultAutoContinue(missionBudgetUsd: number | null): AutoContinueOptions {
  if (missionBudgetUsd === null || missionBudgetUsd <= 0) return { maxRounds: DEFAULT_AUTO_CONTINUE_ROUNDS, budgetUsd: 0 };
  const half = missionBudgetUsd / 2;
  const cents = Math.floor(half * 100) / 100;
  const budget = cents > 0 ? cents : Math.floor(half * 10_000) / 10_000 || missionBudgetUsd;
  return { maxRounds: DEFAULT_AUTO_CONTINUE_ROUNDS, budgetUsd: budget };
}

export function validateAutoContinue(roundsText: string, budgetText: string, missionBudgetUsd: number | null): AutoContinueChange {
  const rounds = parseDecimal(roundsText);
  if (rounds === null || !Number.isInteger(rounds) || rounds < 1 || rounds > AUTO_CONTINUE_LIMITS.maxRounds) {
    return { value: null, error: copy.errors.rounds(AUTO_CONTINUE_LIMITS.maxRounds) };
  }
  const budget = parseDecimal(budgetText);
  // A 0 $ cap would refuse every round: the option would look on and never act.
  if (budget === null || budget <= 0 || budget > 1_000) return { value: null, error: copy.errors.budget };
  if (missionBudgetUsd !== null && budget > missionBudgetUsd) return { value: null, error: copy.errors.overMission };
  return { value: { maxRounds: rounds, budgetUsd: budget }, error: null };
}

/** Modes whose tool set can run commands (run_tests/run_command), per the permission mode table. */
const RUNNING_MODES: ReadonlySet<WorkMode> = new Set(["build", "fix", "verify"]);

/** The option can only act where the mission has tools (not in Discuter). */
export function autoContinueAvailable(mode: WorkMode): boolean {
  return mode !== "discuss";
}

/**
 * Whether NOVA could prove at least one step itself in this mode — the mission loop's rule: a
 * command criterion needs a command, and test/command criteria need a mode that runs commands.
 */
export function planHasProvableCriteria(mode: WorkMode, steps: readonly { acceptance: { kind: AcceptanceKind; detail: string } }[]): boolean {
  return steps.some(({ acceptance }) => {
    if (acceptance.kind === "manual") return false;
    if (acceptance.kind === "file_exists") return true;
    if (acceptance.kind === "command_succeeds" && !acceptance.detail.trim()) return false;
    return RUNNING_MODES.has(mode);
  });
}

function decimalText(value: number): string {
  return String(value).replace(".", ",");
}

export interface AutoContinueOptionProps {
  /** Current choice (null = off). */
  value: AutoContinueOptions | null;
  onChange(change: AutoContinueChange): void;
  /** Mission budget of the contract being edited; null while that field is invalid. */
  missionBudgetUsd: number | null;
  /** false when the mission's mode runs no tool (Discuter): nothing is rendered. */
  available: boolean;
  /** false when every criterion of the plan is to be confirmed by the user. */
  hasCheckableCriteria: boolean;
}

export function AutoContinueOption({ value, onChange, missionBudgetUsd, available, hasCheckableCriteria }: AutoContinueOptionProps) {
  const [on, setOn] = useState(value !== null);
  const [rounds, setRounds] = useState(() => String(value?.maxRounds ?? DEFAULT_AUTO_CONTINUE_ROUNDS));
  const [budget, setBudget] = useState(() => decimalText(value?.budgetUsd ?? defaultAutoContinue(missionBudgetUsd).budgetUsd));
  // Derived from the fields AND the mission budget: lowering the budget can invalidate the cap.
  const change = useMemo<AutoContinueChange>(
    () => (on ? validateAutoContinue(rounds, budget, missionBudgetUsd) : { value: null, error: null }),
    [on, rounds, budget, missionBudgetUsd],
  );
  const reported = useRef(JSON.stringify(value === null ? { value: null, error: null } : { value, error: null }));
  const report = useRef(onChange);
  useEffect(() => {
    report.current = onChange;
  }, [onChange]);
  // Reports each distinct outcome once (field edits and mission budget changes alike).
  useEffect(() => {
    const key = JSON.stringify(change);
    if (reported.current === key) return;
    reported.current = key;
    report.current(change);
  }, [change]);

  if (!available) return null;

  const toggle = (checked: boolean): void => {
    setOn(checked);
    if (!checked) return;
    const initial = defaultAutoContinue(missionBudgetUsd);
    setRounds(String(initial.maxRounds));
    setBudget(decimalText(initial.budgetUsd));
  };

  const roundsError = copy.errors.rounds(AUTO_CONTINUE_LIMITS.maxRounds);
  const missionBudget = missionBudgetUsd === null ? null : formatCost(missionBudgetUsd);
  return (
    <div className="nova-contract__option">
      <Switch label={copy.label} description={copy.description} checked={on} onCheckedChange={toggle} />
      {on ? (
        <>
          {!hasCheckableCriteria ? <p className="nova-note">{copy.manualOnly}</p> : null}
          <TextField
            label={copy.rounds}
            hint={copy.roundsHint(AUTO_CONTINUE_LIMITS.maxRounds)}
            inputMode="numeric"
            value={rounds}
            error={change.error === roundsError ? change.error : undefined}
            onChange={(event) => setRounds(event.target.value)}
          />
          <TextField
            label={copy.budget}
            hint={missionBudget ? copy.budgetHint(missionBudget) : undefined}
            inputMode="decimal"
            value={budget}
            error={change.error !== null && change.error !== roundsError ? change.error : undefined}
            onChange={(event) => setBudget(event.target.value)}
          />
        </>
      ) : null}
    </div>
  );
}
