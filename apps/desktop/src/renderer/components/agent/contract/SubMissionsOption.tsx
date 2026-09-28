// L5 — « Sous-missions » option of the mission contract (MissionContract.harness.subMissions): a
// switch explaining what delegating allows and what still applies, and the maximum number of
// children. Rendered only when the mission's mode can offer start_submission: the sheet never shows
// a switch that would do nothing. Owned by L5; mounted by ContractSheet.
import { SegmentedControl, Switch } from "@nova/ui";
import { SUBMISSION_LIMITS } from "@nova/shared";
import { submissionsCopy } from "../../../copy/fr-submissions";
// Side-effect import: shared with the sub-missions tree (emitted as a file, CSP-safe).
// oxlint-disable-next-line import/no-unassigned-import
import "../../submissions/submissions.css";

const copy = submissionsCopy.option;

export type SubMissionsValue = { maxChildren: number } | null;

export interface SubMissionsOptionProps {
  /** `MissionContractInput.harness.subMissions`: null = off. */
  value: SubMissionsValue;
  onChange(value: SubMissionsValue): void;
  /** false when the mission's mode cannot offer start_submission (e.g. Discuter): nothing is rendered. */
  available: boolean;
}

const COUNTS = Array.from({ length: SUBMISSION_LIMITS.maxChildren }, (_, index) => String(index + 1));
const OPTIONS = COUNTS.map((count) => ({ value: count, label: count }));
/** Default when the switch is turned on: the parallel limit (more rarely helps). */
const DEFAULT_MAX_CHILDREN: number = SUBMISSION_LIMITS.maxParallel;

export function SubMissionsOption({ value, onChange, available }: SubMissionsOptionProps) {
  if (!available) return null;
  return (
    <div className="nova-contract__option">
      <Switch
        label={copy.label}
        description={copy.description}
        checked={value !== null}
        onCheckedChange={(checked) => onChange(checked ? { maxChildren: DEFAULT_MAX_CHILDREN } : null)}
      />
      {value !== null ? (
        <div className="nova-contract__option-row">
          <span aria-hidden>{copy.maxChildren}</span>
          <SegmentedControl
            label={copy.maxChildren}
            size="sm"
            options={OPTIONS}
            value={String(Math.min(Math.max(value.maxChildren, 1), SUBMISSION_LIMITS.maxChildren))}
            onChange={(count) => onChange({ maxChildren: Number(count) })}
          />
        </div>
      ) : null}
      <p className="nova-note">{copy.limits(SUBMISSION_LIMITS.maxParallel)}</p>
    </div>
  );
}
