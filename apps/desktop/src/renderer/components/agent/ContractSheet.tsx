// Plan + contract sheet shown before a mission starts (UX.md minute 5, §7.1; FEATURES A9/A13).
// The plan is editable (reorder, remove, add, rewrite); the contract is prefilled by the profile.
import { useEffect, useId, useRef, useState } from "react";
import { Button, Callout, IconButton, Switch, TextArea, TextField } from "@nova/ui";
import { OPERATION_CLASSES, PERMISSION_PROFILES, type AcceptanceKind, type MissionContractInput, type MissionPlanResult, type MissionTaskDraft } from "@nova/shared";
import { fr } from "../../copy/fr";
import { ACCEPTANCE_LABELS, OPERATION_LABELS, PROFILE_HINTS, PROFILE_LABELS } from "../../copy/fr-atelier";
import { describeUiError, type UiError } from "../../lib/errors";
import { formatCost } from "../../lib/format";
import { MOD_KEY } from "../../lib/platform";
import { PlusIcon, TrashIcon } from "../icons";
import {
  addStep,
  draftFromPlan,
  estimateExceedsCap,
  moveStep,
  parseDecimal,
  removeStep,
  updateStep,
  validateContractDraft,
  type ContractDraft,
  type ContractErrors,
} from "./contract";

const copy = fr.atelier;
const ACCEPTANCE_KINDS: readonly AcceptanceKind[] = ["test_passes", "command_succeeds", "file_exists", "manual"];

export function formatEstimate(estimate: MissionPlanResult["estimate"]): string | null {
  const min = formatCost(estimate.minUsd);
  const max = formatCost(estimate.maxUsd);
  if (min && max) return min === max ? min : `${min} – ${max}`;
  return null;
}

export interface ContractSheetProps {
  result: MissionPlanResult;
  workspacePath: string;
  expert: boolean;
  starting: boolean;
  error: UiError | null;
  /** Why the mission cannot be launched (model without tools); shown next to the disabled button. */
  blocked: { reason: string; action?: { label: string; onAction: () => void } } | null;
  onLaunch: (tasks: MissionTaskDraft[] | null, contract: MissionContractInput) => void;
  onCancel: () => void;
  /** Web toggle chosen in the goal composer; overrides the plan's contract when set. */
  webSearch?: boolean | null;
}

export function ContractSheet({ result, workspacePath, expert, starting, error, blocked, onLaunch, onCancel, webSearch = null }: ContractSheetProps) {
  const id = useId();
  const [draft, setDraft] = useState<ContractDraft>(() => {
    const initial = draftFromPlan(result);
    return webSearch === null ? initial : { ...initial, webSearch };
  });
  const [errors, setErrors] = useState<ContractErrors>({});
  const [editContract, setEditContract] = useState(expert);
  const [newStep, setNewStep] = useState("");
  const estimate = formatEstimate(result.estimate);
  const over = estimateExceedsCap(result.estimate, draft.budgetUsd);
  const cap = formatCost(parseDecimal(draft.budgetUsd));
  const canLaunch = !starting && !blocked;

  const launch = () => {
    if (!canLaunch) return;
    const validation = validateContractDraft(result.mission.id, draft);
    if (!validation.ok) {
      setErrors(validation.errors);
      return;
    }
    setErrors({});
    onLaunch(validation.tasks, validation.contract);
  };

  // Ctrl/⌘+Entrée launches from anywhere in the sheet (POWER_UX §2.2 `mission.launch`). A plain
  // Entrée never does: the launch button is not a submit button, so a text field cannot spend money.
  const form = useRef<HTMLFormElement>(null);
  const launchRef = useRef(launch);
  useEffect(() => {
    launchRef.current = launch;
  });
  useEffect(() => {
    const element = form.current;
    if (!element) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey) {
        event.preventDefault();
        launchRef.current();
      }
    };
    element.addEventListener("keydown", onKeyDown);
    return () => element.removeEventListener("keydown", onKeyDown);
  }, []);

  const edit = (next: ContractDraft) => {
    setDraft(next);
    if (Object.keys(errors).length > 0) setErrors({});
  };

  return (
    <form
      ref={form}
      className="nova-contract"
      aria-labelledby={`${id}-plan`}
      onSubmit={(event) => {
        // Implicit submission (Entrée in a field) must not launch a paid mission.
        event.preventDefault();
      }}
    >
      <section className="nova-contract__block" aria-labelledby={`${id}-plan`}>
        <h2 id={`${id}-plan`} className="nova-contract__title">
          {copy.plan.title} : {result.mission.title}
        </h2>
        {result.summary ? <p className="nova-contract__summary">{result.summary}</p> : null}
        <h3 className="nova-contract__subtitle">
          {copy.plan.stepsHeading}
          {draft.stepsEdited ? <span className="nova-contract__edited"> · {copy.plan.edited}</span> : null}
        </h3>
        {errors.steps ? (
          <p className="nova-contract__error" role="alert">
            {errors.steps}
          </p>
        ) : null}
        <ol className="nova-contract__steps">
          {draft.steps.map((step, index) => (
            <li key={step.key} className="nova-contract__step">
              <span className="nova-contract__step-number" aria-hidden>
                {index + 1}
              </span>
              <div className="nova-contract__step-body">
                <TextField
                  label={copy.plan.stepTitleLabel(index + 1)}
                  hideLabel
                  value={step.title}
                  error={errors.stepTitles?.[step.key]}
                  onChange={(event) => edit(updateStep(draft, step.key, { title: event.target.value }))}
                />
                <div className="nova-contract__acceptance">
                  <label className="nova-contract__inline-label">
                    <span>{copy.plan.acceptanceLabel(index + 1)}</span>
                    <select
                      className="nv-field__control nova-contract__select"
                      value={step.acceptanceKind}
                      onChange={(event) =>
                        edit(updateStep(draft, step.key, { acceptanceKind: event.target.value as AcceptanceKind }))
                      }
                    >
                      {ACCEPTANCE_KINDS.map((kind) => (
                        <option key={kind} value={kind}>
                          {ACCEPTANCE_LABELS[kind]}
                        </option>
                      ))}
                    </select>
                  </label>
                  {expert || step.acceptanceKind !== "manual" ? (
                    <TextField
                      label={copy.plan.acceptanceDetailLabel(index + 1)}
                      hideLabel
                      className="nova-contract__detail"
                      value={step.acceptanceDetail}
                      placeholder={ACCEPTANCE_LABELS[step.acceptanceKind]}
                      onChange={(event) => edit(updateStep(draft, step.key, { acceptanceDetail: event.target.value }))}
                    />
                  ) : null}
                </div>
              </div>
              <span className="nova-contract__step-actions">
                <IconButton
                  size="sm"
                  aria-label={copy.plan.moveUp(index + 1)}
                  icon={<span aria-hidden>↑</span>}
                  disabled={index === 0}
                  onClick={() => edit(moveStep(draft, step.key, -1))}
                />
                <IconButton
                  size="sm"
                  aria-label={copy.plan.moveDown(index + 1)}
                  icon={<span aria-hidden>↓</span>}
                  disabled={index === draft.steps.length - 1}
                  onClick={() => edit(moveStep(draft, step.key, 1))}
                />
                <IconButton
                  size="sm"
                  aria-label={copy.plan.remove(index + 1)}
                  icon={<TrashIcon size={14} />}
                  onClick={() => edit(removeStep(draft, step.key))}
                />
              </span>
            </li>
          ))}
        </ol>
        <div className="nova-contract__add">
          <TextField
            label={copy.plan.newStep}
            hideLabel
            placeholder={copy.plan.newStep}
            value={newStep}
            onChange={(event) => setNewStep(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.ctrlKey && !event.metaKey && newStep.trim()) {
                event.preventDefault();
                edit(addStep(draft, newStep.trim()));
                setNewStep("");
              }
            }}
          />
          <Button
            size="sm"
            variant="secondary"
            icon={<PlusIcon size={14} />}
            disabled={newStep.trim() === ""}
            onClick={() => {
              edit(addStep(draft, newStep.trim()));
              setNewStep("");
            }}
          >
            {copy.plan.add}
          </Button>
        </div>
      </section>

      <section className="nova-contract__block" aria-labelledby={`${id}-contract`}>
        <h2 id={`${id}-contract`} className="nova-contract__title">
          {expert ? copy.contract.titleExpert : copy.contract.title}
        </h2>
        <ul className="nova-contract__facts">
          <li>{copy.contract.folder(workspacePath)}</li>
          <li>
            {copy.contract.profile} : <strong>{PROFILE_LABELS[draft.profile]}</strong>
          </li>
          <li>{draft.hostsText.trim() ? `${copy.contract.hosts} : ${draft.hostsText.split(/\s+/).filter(Boolean).join(", ")}` : copy.contract.hostsNone}</li>
          <li>{draft.webSearch ? copy.context.webOn : copy.context.webOff}</li>
          <li>{copy.contract.asksBefore}</li>
          <li>
            {copy.contract.isolation} :{" "}
            {result.contract.isolationLevel === "L0"
              ? copy.contract.isolationL0
              : result.contract.isolationLevel === "L1"
                ? copy.contract.isolationL1
                : copy.contract.isolationL2}
          </li>
        </ul>

        <div className="nova-contract__row">
          <TextField
            label={copy.contract.duration}
            inputMode="numeric"
            value={draft.durationMinutes}
            error={errors.duration}
            onChange={(event) => edit({ ...draft, durationMinutes: event.target.value })}
          />
          <TextField
            label={copy.contract.budget}
            inputMode="decimal"
            value={draft.budgetUsd}
            error={errors.budget}
            onChange={(event) => edit({ ...draft, budgetUsd: event.target.value })}
          />
        </div>
        <p className="nova-contract__estimate">
          {estimate ? copy.contract.estimate(estimate) : copy.contract.estimateUnknown}
          {result.estimate.assumptions ? <span className="nova-note"> {copy.contract.assumptions(result.estimate.assumptions)}</span> : null}
        </p>
        {over && cap ? <Callout tone="warning">{copy.contract.estimateOver(cap)}</Callout> : null}

        {editContract ? (
          <div className="nova-contract__expert">
            <fieldset className="nova-contract__fieldset">
              <legend>{copy.contract.profile}</legend>
              {PERMISSION_PROFILES.map((profile) => (
                <label key={profile} className="nova-contract__radio">
                  <input
                    type="radio"
                    name={`${id}-profile`}
                    value={profile}
                    checked={draft.profile === profile}
                    onChange={() => edit({ ...draft, profile })}
                  />
                  <strong>{PROFILE_LABELS[profile]}</strong>
                  <span className="nova-note">{PROFILE_HINTS[profile]}</span>
                </label>
              ))}
            </fieldset>
            <fieldset className="nova-contract__fieldset">
              <legend>{copy.contract.operations}</legend>
              {OPERATION_CLASSES.map((operation) => (
                <label key={operation} className="nova-contract__check">
                  <input
                    type="checkbox"
                    checked={draft.allowedOperations.includes(operation)}
                    onChange={(event) =>
                      edit({
                        ...draft,
                        allowedOperations: event.target.checked
                          ? [...draft.allowedOperations, operation]
                          : draft.allowedOperations.filter((item) => item !== operation),
                      })
                    }
                  />
                  <span>{OPERATION_LABELS[operation]}</span>
                </label>
              ))}
            </fieldset>
            <TextArea
              label={copy.contract.hosts}
              hint={copy.contract.hostsHint}
              rows={3}
              value={draft.hostsText}
              error={errors.hosts}
              onChange={(event) => edit({ ...draft, hostsText: event.target.value })}
            />
            <Switch
              label={copy.contract.webSearch}
              description={copy.contract.webSearchHint}
              checked={draft.webSearch}
              onCheckedChange={(checked) => edit({ ...draft, webSearch: checked })}
            />
          </div>
        ) : (
          <>
            {errors.hosts ? (
              <p className="nova-contract__error" role="alert">
                {errors.hosts}
              </p>
            ) : null}
            <Button size="sm" variant="ghost" onClick={() => setEditContract(true)}>
              {copy.contract.edit}
            </Button>
          </>
        )}
      </section>

      {error ? (
        <Callout tone="danger" title={copy.contract.launchFailed}>
          <p>{describeUiError(error).title}</p>
        </Callout>
      ) : null}
      {blocked ? (
        <output className="nova-contract__blocked">
          <span>{blocked.reason}</span>
          {blocked.action ? (
            <Button size="sm" variant="ghost" onClick={blocked.action.onAction}>
              {blocked.action.label}
            </Button>
          ) : null}
        </output>
      ) : null}
      <div className="nova-contract__actions">
        <Button variant="primary" loading={starting} disabled={!canLaunch} onClick={launch} aria-keyshortcuts="Control+Enter Meta+Enter" title={`${copy.contract.launch} (${MOD_KEY}+Entrée)`}>
          {copy.contract.launch}
        </Button>
        <Button variant="ghost" onClick={onCancel} disabled={starting}>
          {copy.contract.cancel}
        </Button>
        <span className="nova-note">{copy.contract.launchHint.replace("Ctrl", MOD_KEY)}</span>
      </div>
    </form>
  );
}
