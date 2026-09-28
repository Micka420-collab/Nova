// Create / edit one schedule (L6): mission template (goal, mode, model), trigger with a live
// preview of the next runs (same code as main), explained missed-run policy, and the contract of
// every run (permissions, budget, duration). Saving ends in a visible outcome: the saved schedule
// (the manager announces it) or the error under the form.
import { useId, useMemo, useState } from "react";
import { Button, Callout, SegmentedControl, Switch, TextArea, TextField } from "@nova/ui";
import { MISSED_RUN_POLICIES, NovaIpcError, SCHEDULABLE_MODES, type Schedule } from "@nova/shared";
import { WEEKDAY_ORDER, WEEKDAY_SHORT, WEEKDAY_LABELS, scheduleErrorCopy, schedulesCopy } from "../../copy/fr-schedules";
import { PROFILE_HINTS, PROFILE_LABELS, WORK_MODE_HINTS, WORK_MODE_LABELS } from "../../copy/fr-atelier";
import { formatInstant } from "./schedule-format";
import {
  SCHEDULE_PROFILES,
  draftFromSchedule,
  emptyScheduleDraft,
  previewRuns,
  validateScheduleDraft,
  type ScheduleDraft,
  type ScheduleDraftErrors,
  type ScheduleFields,
  type TriggerKind,
} from "./schedule-form";

const copy = schedulesCopy.form;
const KINDS: readonly TriggerKind[] = ["once", "interval", "daily", "weekly", "cron"];

export interface ScheduleModelChoice {
  id: string;
  name: string;
  /** null = the catalog does not say. */
  supportsTools: boolean | null;
}

export interface ScheduleEditorProps {
  /** null = new schedule. */
  schedule: Schedule | null;
  models: readonly ScheduleModelChoice[];
  defaultModelId: string | null;
  save(fields: ScheduleFields): Promise<void>;
  onCancel(): void;
  now?: () => number;
}

export function ScheduleEditor({ schedule, models, defaultModelId, save, onCancel, now = Date.now }: ScheduleEditorProps) {
  const id = useId();
  const usable = models.filter((model) => model.supportsTools !== false);
  const [draft, setDraft] = useState<ScheduleDraft>(() =>
    schedule
      ? draftFromSchedule(schedule, now())
      : emptyScheduleDraft({ modelId: usable.find((model) => model.id === defaultModelId)?.id ?? usable[0]?.id ?? "", now: now() }),
  );
  const [errors, setErrors] = useState<ScheduleDraftErrors>({});
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const preview = useMemo(() => previewRuns(draft, now()), [draft, now]);
  const edit = (patch: Partial<ScheduleDraft>) => setDraft((current) => ({ ...current, ...patch }));
  const zoned = draft.kind === "daily" || draft.kind === "weekly" || draft.kind === "cron";
  // A model not offered any more (catalog changed) stays selectable for an existing schedule.
  const modelOptions = usable.some((model) => model.id === draft.modelId) || draft.modelId === "" ? usable : [...usable, { id: draft.modelId, name: draft.modelId, supportsTools: null }];

  const submit = async (): Promise<void> => {
    const result = validateScheduleDraft(draft, now());
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    setSaveError(null);
    setSaving(true);
    try {
      await save(result.fields);
    } catch (error) {
      setSaveError(scheduleErrorCopy(error instanceof NovaIpcError ? error.code : null));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      className="nova-sched-form"
      aria-labelledby={`${id}-title`}
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <h2 id={`${id}-title`} className="nova-sched__subtitle">
        {schedule ? copy.editTitle : copy.createTitle}
      </h2>
      <TextField label={copy.name} value={draft.title} error={errors.title} maxLength={120} onChange={(event) => edit({ title: event.target.value })} />
      <TextArea label={copy.goal} hint={copy.goalHint} rows={3} value={draft.goal} error={errors.goal} onChange={(event) => edit({ goal: event.target.value })} />

      <div className="nova-sched-form__row">
        <label className="nova-sched-form__label">
          <span>{copy.mode}</span>
          <select className="nv-field__control" value={draft.mode} onChange={(event) => edit({ mode: event.target.value as ScheduleDraft["mode"] })}>
            {SCHEDULABLE_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {WORK_MODE_LABELS[mode]}
              </option>
            ))}
          </select>
          <span className="nova-note">{WORK_MODE_HINTS[draft.mode]}</span>
        </label>
        <label className="nova-sched-form__label">
          <span>{copy.model}</span>
          {modelOptions.length === 0 ? (
            <span className="nova-note">{copy.modelNone}</span>
          ) : (
            <select
              className="nv-field__control"
              value={draft.modelId}
              aria-invalid={errors.model ? true : undefined}
              onChange={(event) => edit({ modelId: event.target.value })}
            >
              {modelOptions.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.name}
                </option>
              ))}
            </select>
          )}
          {errors.model ? <span className="nova-sched-form__error">{errors.model}</span> : null}
        </label>
      </div>

      <fieldset className="nova-sched-form__fieldset">
        <legend>{copy.when}</legend>
        <SegmentedControl
          label={copy.when}
          options={KINDS.map((kind) => ({ value: kind, label: copy.kinds[kind] }))}
          value={draft.kind}
          onChange={(kind) => edit({ kind })}
        />
        {draft.kind === "once" ? (
          <TextField label={copy.at} type="datetime-local" value={draft.onceAt} onChange={(event) => edit({ onceAt: event.target.value })} />
        ) : null}
        {draft.kind === "interval" ? (
          <TextField label={copy.every} inputMode="numeric" value={draft.everyMinutes} onChange={(event) => edit({ everyMinutes: event.target.value })} />
        ) : null}
        {draft.kind === "daily" || draft.kind === "weekly" ? (
          <TextField label={copy.time} type="time" value={draft.time} onChange={(event) => edit({ time: event.target.value })} />
        ) : null}
        {draft.kind === "weekly" ? (
          <fieldset className="nova-sched-form__days">
            <legend>{copy.days}</legend>
            {WEEKDAY_ORDER.map((day) => (
              <label key={day} className="nova-sched-form__day" title={WEEKDAY_LABELS[day]}>
                <input
                  type="checkbox"
                  aria-label={WEEKDAY_LABELS[day]}
                  checked={draft.days.includes(day)}
                  onChange={(event) => edit({ days: event.target.checked ? [...draft.days, day] : draft.days.filter((item) => item !== day) })}
                />
                <span aria-hidden="true">{WEEKDAY_SHORT[day]}</span>
              </label>
            ))}
          </fieldset>
        ) : null}
        {draft.kind === "cron" ? (
          <TextField label={copy.cron} hint={copy.cronHint} spellCheck={false} value={draft.cron} onChange={(event) => edit({ cron: event.target.value })} />
        ) : null}
        {zoned ? (
          <TextField label={copy.timeZone} hint={copy.timeZoneHint} error={errors.timeZone} spellCheck={false} value={draft.timeZone} onChange={(event) => edit({ timeZone: event.target.value })} />
        ) : null}
        {errors.trigger ? (
          <p className="nova-sched-form__error" role="alert">
            {errors.trigger}
          </p>
        ) : null}
        <section className="nova-sched-form__preview" aria-label={copy.preview}>
          <h3 className="nova-sched-form__legend">{copy.preview}</h3>
          {preview.length === 0 ? (
            <p className="nova-note">{copy.previewNone}</p>
          ) : (
            <ol>
              {preview.map((instant) => (
                <li key={instant}>{formatInstant(instant)}</li>
              ))}
            </ol>
          )}
        </section>
      </fieldset>

      <fieldset className="nova-sched-form__fieldset">
        <legend>{copy.missed}</legend>
        {MISSED_RUN_POLICIES.map((policy) => (
          <label key={policy} className="nova-sched-form__radio">
            <input type="radio" name={`${id}-missed`} value={policy} checked={draft.missedPolicy === policy} onChange={() => edit({ missedPolicy: policy })} />
            <strong>{copy.policies[policy].label}</strong>
            <span className="nova-note">{copy.policies[policy].hint}</span>
          </label>
        ))}
      </fieldset>

      <fieldset className="nova-sched-form__fieldset">
        <legend>{copy.contract}</legend>
        <fieldset className="nova-sched-form__fieldset nova-sched-form__fieldset--inner">
          <legend>{copy.profile}</legend>
          {SCHEDULE_PROFILES.map((profile) => (
            <label key={profile} className="nova-sched-form__radio">
              <input type="radio" name={`${id}-profile`} value={profile} checked={draft.profile === profile} onChange={() => edit({ profile })} />
              <strong>{PROFILE_LABELS[profile]}</strong>
              <span className="nova-note">{PROFILE_HINTS[profile]}</span>
            </label>
          ))}
        </fieldset>
        <Switch label={copy.webSearch} checked={draft.webSearch} onCheckedChange={(webSearch) => edit({ webSearch })} />
        <div className="nova-sched-form__row">
          <TextField label={copy.budget} hint={copy.budgetHint} inputMode="decimal" value={draft.budgetUsd} error={errors.budget} onChange={(event) => edit({ budgetUsd: event.target.value })} />
          <TextField label={copy.duration} inputMode="numeric" value={draft.durationMinutes} error={errors.duration} onChange={(event) => edit({ durationMinutes: event.target.value })} />
        </div>
      </fieldset>

      <p className="nova-note">{schedulesCopy.sameRules}</p>
      {saveError ? (
        <Callout tone="danger" role="alert">
          {copy.saveFailed} {saveError}
        </Callout>
      ) : null}
      <div className="nova-sched-form__actions">
        <Button type="submit" variant="primary" loading={saving}>
          {copy.save}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          {copy.cancel}
        </Button>
      </div>
    </form>
  );
}
