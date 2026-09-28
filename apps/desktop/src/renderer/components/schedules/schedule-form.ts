// Schedule editor model (L6): the form as the user types it, its validation into a
// `schedules.create` / `schedules.update` payload, and the preview of the next runs. Pure: the
// trigger semantics come from @nova/scheduler (the same code main uses), so the preview shown is
// the schedule main will run.
import { checkTrigger, nextRuns } from "@nova/scheduler";
import {
  OPERATION_CLASSES,
  SCHEDULE_LIMITS,
  isIanaTimeZone,
  type MissedRunPolicy,
  type MissionContractInput,
  type OperationClass,
  type Schedule,
  type ScheduleTrigger,
  type WorkMode,
} from "@nova/shared";
import { schedulesCopy } from "../../copy/fr-schedules";
import { parseDecimal } from "../agent/contract";

export type TriggerKind = ScheduleTrigger["kind"];
export type SchedulableMode = Exclude<WorkMode, "discuss">;
/** Profiles offered by the editor (custom needs the full contract sheet). */
export type ScheduleProfile = "read_only" | "assisted" | "autonomous";
export const SCHEDULE_PROFILES: readonly ScheduleProfile[] = ["read_only", "assisted", "autonomous"];

const copy = schedulesCopy.form.errors;
const DEFAULT_BUDGET_USD = "0,5";
const DEFAULT_DURATION_MIN = "15";
const MAX_DURATION_MIN = 24 * 60;
const MAX_BUDGET_USD = 1_000;

export interface ScheduleDraft {
  title: string;
  goal: string;
  mode: SchedulableMode;
  modelId: string;
  kind: TriggerKind;
  /** `datetime-local` value ("YYYY-MM-DDTHH:MM", local time of this computer). */
  onceAt: string;
  everyMinutes: string;
  time: string;
  /** 0 = Sunday … 6 = Saturday. */
  days: number[];
  cron: string;
  timeZone: string;
  missedPolicy: MissedRunPolicy;
  profile: ScheduleProfile;
  webSearch: boolean;
  budgetUsd: string;
  durationMinutes: string;
  /** Contract of the schedule being edited (J2-B options and operations are kept as they were). */
  baseContract: MissionContractInput | null;
}

export interface ScheduleDraftErrors {
  title?: string;
  goal?: string;
  model?: string;
  trigger?: string;
  timeZone?: string;
  budget?: string;
  duration?: string;
}

export interface ScheduleFields {
  title: string;
  goal: string;
  mode: SchedulableMode;
  modelId: string;
  contract: MissionContractInput;
  trigger: ScheduleTrigger;
  missedPolicy: MissedRunPolicy;
}

export type ScheduleDraftValidation = { ok: true; fields: ScheduleFields } | { ok: false; errors: ScheduleDraftErrors };

export function localTimeZone(): string {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return isIanaTimeZone(zone) ? zone : "UTC";
  } catch {
    return "UTC";
  }
}

const pad = (value: number) => String(value).padStart(2, "0");

/** `datetime-local` value of an instant, in this computer's time. */
export function toLocalInput(instant: number): string {
  const date = new Date(instant);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function fromLocalInput(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const instant = new Date(value).getTime();
  return Number.isFinite(instant) ? instant : null;
}

const decimal = (value: number) => String(value).replace(".", ",");

export function emptyScheduleDraft(options: { modelId: string; now: number; timeZone?: string }): ScheduleDraft {
  return {
    title: "",
    goal: "",
    mode: "verify",
    modelId: options.modelId,
    kind: "daily",
    onceAt: toLocalInput(options.now + 60 * 60_000),
    everyMinutes: "60",
    time: "09:00",
    days: [1, 2, 3, 4, 5],
    cron: "0 9 * * 1-5",
    timeZone: options.timeZone ?? localTimeZone(),
    missedPolicy: "skip",
    profile: "assisted",
    webSearch: false,
    budgetUsd: DEFAULT_BUDGET_USD,
    durationMinutes: DEFAULT_DURATION_MIN,
    baseContract: null,
  };
}

export function draftFromSchedule(schedule: Schedule, now: number): ScheduleDraft {
  const base = emptyScheduleDraft({ modelId: schedule.modelId, now });
  const trigger = schedule.trigger;
  const profile = SCHEDULE_PROFILES.find((item) => item === schedule.contract.profile) ?? "assisted";
  return {
    ...base,
    title: schedule.title,
    goal: schedule.goal,
    mode: schedule.mode,
    kind: trigger.kind,
    onceAt: trigger.kind === "once" ? toLocalInput(trigger.at) : base.onceAt,
    everyMinutes: trigger.kind === "interval" ? String(trigger.everyMinutes) : base.everyMinutes,
    time: trigger.kind === "daily" || trigger.kind === "weekly" ? trigger.time : base.time,
    days: trigger.kind === "weekly" ? [...trigger.days] : base.days,
    cron: trigger.kind === "cron" ? trigger.expression : base.cron,
    timeZone: "timeZone" in trigger ? trigger.timeZone : base.timeZone,
    missedPolicy: schedule.missedPolicy,
    profile,
    webSearch: schedule.contract.webSearch,
    budgetUsd: decimal(schedule.contract.budgetUsd),
    durationMinutes: String(Math.round(schedule.contract.maxDurationMs / 60_000)),
    baseContract: schedule.contract,
  };
}

/** The trigger the draft describes, or the reason it cannot be one. */
export function triggerOfDraft(draft: ScheduleDraft, now: number): { ok: true; trigger: ScheduleTrigger } | { ok: false; error: string; field: "trigger" | "timeZone" } {
  const zoned = draft.kind === "daily" || draft.kind === "weekly" || draft.kind === "cron";
  if (zoned && !isIanaTimeZone(draft.timeZone.trim())) return { ok: false, error: copy.timeZone, field: "timeZone" };
  const timeZone = draft.timeZone.trim();
  let trigger: ScheduleTrigger;
  switch (draft.kind) {
    case "once": {
      const at = fromLocalInput(draft.onceAt);
      if (at === null || at <= now) return { ok: false, error: copy.at, field: "trigger" };
      trigger = { kind: "once", at };
      break;
    }
    case "interval": {
      const every = /^\d+$/.test(draft.everyMinutes.trim()) ? Number(draft.everyMinutes.trim()) : Number.NaN;
      if (!(every >= SCHEDULE_LIMITS.minIntervalMinutes && every <= SCHEDULE_LIMITS.maxIntervalMinutes)) {
        return { ok: false, error: copy.every, field: "trigger" };
      }
      trigger = { kind: "interval", everyMinutes: every };
      break;
    }
    case "daily":
    case "weekly": {
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(draft.time)) return { ok: false, error: copy.time, field: "trigger" };
      if (draft.kind === "daily") trigger = { kind: "daily", time: draft.time, timeZone };
      else {
        if (draft.days.length === 0) return { ok: false, error: copy.days, field: "trigger" };
        trigger = { kind: "weekly", days: [...new Set(draft.days)].sort((a, b) => a - b), time: draft.time, timeZone };
      }
      break;
    }
    case "cron":
      trigger = { kind: "cron", expression: draft.cron.trim().replace(/\s+/g, " "), timeZone };
      break;
  }
  const check = checkTrigger(trigger, now);
  if (!check.ok) {
    if (check.reason === "invalid_cron") return { ok: false, error: copy.cron(check.detail), field: "trigger" };
    return { ok: false, error: draft.kind === "once" ? copy.at : copy.cronNever, field: "trigger" };
  }
  return { ok: true, trigger };
}

/** The next runs of the draft (empty when its trigger is invalid). */
export function previewRuns(draft: ScheduleDraft, now: number, count = 5): number[] {
  const result = triggerOfDraft(draft, now);
  return result.ok ? nextRuns(result.trigger, now, count) : [];
}

function operationsOf(profile: ScheduleProfile): OperationClass[] {
  return profile === "read_only" ? ["read", "network"] : [...OPERATION_CLASSES];
}

export function validateScheduleDraft(draft: ScheduleDraft, now: number): ScheduleDraftValidation {
  const errors: ScheduleDraftErrors = {};
  const title = draft.title.trim();
  const goal = draft.goal.trim();
  if (title.length === 0 || title.length > SCHEDULE_LIMITS.titleMaxChars) errors.title = copy.title;
  if (goal.length === 0 || goal.length > SCHEDULE_LIMITS.goalMaxChars) errors.goal = copy.goal;
  if (draft.modelId.trim() === "") errors.model = copy.model;
  const trigger = triggerOfDraft(draft, now);
  if (!trigger.ok) errors[trigger.field] = trigger.error;
  const budget = parseDecimal(draft.budgetUsd);
  if (budget === null || budget > MAX_BUDGET_USD) errors.budget = copy.budget;
  const duration = /^\d+$/.test(draft.durationMinutes.trim()) ? Number(draft.durationMinutes.trim()) : Number.NaN;
  if (!(duration >= 1 && duration <= MAX_DURATION_MIN)) errors.duration = copy.duration;
  if (Object.keys(errors).length > 0 || !trigger.ok || budget === null) return { ok: false, errors };

  const base = draft.baseContract;
  const keepOperations = base !== null && base.profile === draft.profile;
  const contract: MissionContractInput = {
    ...(base ?? {}),
    profile: draft.profile,
    allowedOperations: keepOperations ? base.allowedOperations : operationsOf(draft.profile),
    allowedHosts: base?.allowedHosts ?? [],
    webSearch: draft.webSearch,
    maxDurationMs: duration * 60_000,
    budgetUsd: budget,
  };
  return {
    ok: true,
    fields: { title, goal, mode: draft.mode, modelId: draft.modelId, contract, trigger: trigger.trigger, missedPolicy: draft.missedPolicy },
  };
}
