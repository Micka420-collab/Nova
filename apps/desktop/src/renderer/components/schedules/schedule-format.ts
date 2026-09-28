// French descriptions of schedules and runs (L6). Pure; instants are shown in this computer's time,
// the trigger's own zone is named when it differs.
import type { ScheduleRun, ScheduleTrigger } from "@nova/shared";
import { WEEKDAY_LABELS, WEEKDAY_ORDER, schedulesCopy } from "../../copy/fr-schedules";

const copy = schedulesCopy;

const dateTime = new Intl.DateTimeFormat("fr-FR", { weekday: "short", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });

export function formatInstant(instant: number): string {
  return dateTime.format(new Date(instant));
}

function weekdays(days: readonly number[]): string {
  const set = new Set(days);
  const ordered = WEEKDAY_ORDER.filter((day) => set.has(day)).map((day) => WEEKDAY_LABELS[day]);
  if (ordered.length <= 1) return ordered.join("");
  return `${ordered.slice(0, -1).join(", ")} et ${ordered.at(-1) ?? ""}`;
}

/** One line for a trigger; `localZone` is this computer's zone (the trigger's is named if different). */
export function describeTrigger(trigger: ScheduleTrigger, localZone: string): string {
  const zone = "timeZone" in trigger && trigger.timeZone !== localZone ? ` (${copy.timeZoneNote(trigger.timeZone)})` : "";
  switch (trigger.kind) {
    case "once":
      return copy.trigger.once(formatInstant(trigger.at));
    case "interval":
      return copy.trigger.interval(trigger.everyMinutes);
    case "daily":
      return copy.trigger.daily(trigger.time) + zone;
    case "weekly":
      return copy.trigger.weekly(weekdays(trigger.days), trigger.time) + zone;
    case "cron":
      return copy.trigger.cron(trigger.expression) + zone;
  }
}

/** Outcome of a run with its reason, in French (the detail code never reaches the UI raw). */
export function describeRun(run: ScheduleRun): string {
  const label = copy.runs.outcome[run.outcome];
  const detail = run.detail;
  if (detail === null) return label;
  if (detail.startsWith("start_failed:")) {
    const reason = copy.runs.startFailure[detail.slice("start_failed:".length)] ?? copy.runs.startFailure["internal"];
    return `${label} : ${reason}`;
  }
  const reason = copy.runs.detail[detail];
  return reason ? `${label} : ${reason}` : label;
}

export type RunTone = "neutral" | "jade" | "amber" | "danger";

export function runTone(run: ScheduleRun): RunTone {
  switch (run.outcome) {
    case "running":
    case "succeeded":
      return "jade";
    case "failed":
    case "error":
      return "danger";
    case "suspended":
    case "skipped_budget":
    case "skipped_missed":
    case "skipped_overlap":
      return "amber";
    case "cancelled":
      return "neutral";
  }
}
