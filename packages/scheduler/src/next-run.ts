// `nextRunAt(trigger, after)`: pure, the first due instant STRICTLY after `after`, or null when the
// trigger never fires again (a past `once`, an impossible cron within the search horizon).
// - once: `at` if it is still ahead;
// - interval: `after + every` (the scheduler passes the previous DUE time, so runs stay anchored);
// - daily / weekly: the local wall time in the schedule's IANA zone (DST: see zoned.ts — a time in
//   the spring-forward gap runs after the jump, a repeated time runs once);
// - cron: local wall times of the zone; minutes inside a DST gap do not exist and are skipped, a
//   repeated hour runs once.
import type { ScheduleTrigger } from "@nova/shared";
import { cronMatchesDay, parseCron, type CronSpec } from "./cron";
import { addDays, instantOf, wallTimeOf, type WallTime } from "./zoned";

/** Days searched ahead for a daily/weekly/cron match (covers Feb 29 on a given weekday). */
const SEARCH_HORIZON_DAYS = 366 * 8;

export type TriggerCheck = { ok: true } | { ok: false; reason: "invalid_cron" | "never_runs"; detail: string };

function parseTime(time: string): { hour: number; minute: number } {
  const [hour, minute] = time.split(":").map(Number);
  return { hour: hour ?? 0, minute: minute ?? 0 };
}

function nextWallRun(
  after: number,
  timeZone: string,
  dayMatches: (day: { month: number; day: number; weekday: number }) => boolean,
  times: (day: { year: number; month: number; day: number }) => Iterable<{ hour: number; minute: number }>,
  exact: boolean,
): number | null {
  const start = wallTimeOf(after, timeZone);
  // Naive (zone-less) wall times well before `after` cannot be ahead of it: skipped without an
  // Intl round trip (a DST shift never exceeds a few hours).
  const naiveFloor = Date.UTC(start.year, start.month - 1, start.day, start.hour, start.minute) - 3 * 3_600_000;
  // Start one day early: a wall time late on the previous local day can still be ahead of `after`
  // right after a fall-back transition.
  for (let offset = -1; offset <= SEARCH_HORIZON_DAYS; offset += 1) {
    const day = addDays(start, offset);
    if (!dayMatches(day)) continue;
    for (const time of times(day)) {
      if (offset <= 0 && Date.UTC(day.year, day.month - 1, day.day, time.hour, time.minute) < naiveFloor) continue;
      const wall: WallTime = { year: day.year, month: day.month, day: day.day, hour: time.hour, minute: time.minute };
      const instant = instantOf(wall, timeZone, { exact });
      if (instant !== null && instant > after) return instant;
    }
  }
  return null;
}

function* cronTimes(spec: CronSpec): Iterable<{ hour: number; minute: number }> {
  for (const hour of spec.hours) for (const minute of spec.minutes) yield { hour, minute };
}

export function nextRunAt(trigger: ScheduleTrigger, after: number): number | null {
  switch (trigger.kind) {
    case "once":
      return trigger.at > after ? trigger.at : null;
    case "interval":
      return after + trigger.everyMinutes * 60_000;
    case "daily": {
      const time = parseTime(trigger.time);
      return nextWallRun(after, trigger.timeZone, () => true, () => [time], false);
    }
    case "weekly": {
      const time = parseTime(trigger.time);
      const days = new Set(trigger.days);
      return nextWallRun(after, trigger.timeZone, (day) => days.has(day.weekday), () => [time], false);
    }
    case "cron": {
      const parsed = parseCron(trigger.expression);
      if (!parsed.ok) return null;
      const spec = parsed.spec;
      return nextWallRun(after, trigger.timeZone, (day) => cronMatchesDay(spec, day), () => cronTimes(spec), true);
    }
  }
}

/** The next `count` due instants after `after` (preview of a schedule being edited). */
export function nextRuns(trigger: ScheduleTrigger, after: number, count: number): number[] {
  const runs: number[] = [];
  let cursor = after;
  while (runs.length < count) {
    const next = nextRunAt(trigger, cursor);
    if (next === null) break;
    runs.push(next);
    cursor = next;
  }
  return runs;
}

/** Semantic check beyond the schema: a parsable cron, and a trigger that fires at least once. */
export function checkTrigger(trigger: ScheduleTrigger, now: number): TriggerCheck {
  if (trigger.kind === "cron") {
    const parsed = parseCron(trigger.expression);
    if (!parsed.ok) return { ok: false, reason: "invalid_cron", detail: parsed.reason };
  }
  if (nextRunAt(trigger, now) === null) {
    return { ok: false, reason: "never_runs", detail: trigger.kind === "once" ? "the time is already past" : "no matching time" };
  }
  return { ok: true };
}
