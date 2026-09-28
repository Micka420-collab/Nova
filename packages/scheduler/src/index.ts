// @nova/scheduler — scheduled missions (Pr5, L6). Owned by lane L6.
//
// - `nextRunAt(trigger, after)`: pure; once / interval (≥ 1 min) / daily / weekly (IANA time zone,
//   DST-safe via Intl) / 5-field cron parsed in-house (no dependency). Pure and DOM-safe: the
//   renderer imports it to preview the next runs of a schedule being edited.
// - `createScheduler`: runs in main while NOVA runs (the tray keeps it alive, L7). At startup it
//   settles runs a previous session left open, applies each schedule's missed-run policy
//   (`skip` | `run_once`) and records every due time in schedule_runs; it never overlaps two runs
//   of one schedule, respects the daily budget, and starts each run as a normal mission (same
//   contract, budget, permission engine and approvals).
import type { ScheduleTrigger } from "@nova/shared";

export { parseCron, cronMatchesDay, type CronSpec, type CronParseResult } from "./cron";
export { nextRunAt, nextRuns, checkTrigger, type TriggerCheck } from "./next-run";
export {
  createScheduler,
  type Scheduler,
  type SchedulerDeps,
  type ScheduleEndOutcome,
  type ScheduleStoreLike,
  type TimerHandle,
} from "./scheduler";

export type NextRunAt = (trigger: ScheduleTrigger, after: number) => number | null;
