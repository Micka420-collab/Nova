// @nova/scheduler — scheduled missions (Pr5, L6). Owned by lane L6.
//
// - `nextRunAt(trigger, after)`: pure; once / interval (≥ 1 min) / daily / weekly (IANA time zone,
//   DST-safe via Intl) / 5-field cron. No new dependency without an ADR (docs/DECISIONS.md).
// - The scheduler runs in main while NOVA runs (the tray keeps it alive, L7). At startup it applies
//   each schedule's missed-run policy (`skip` | `run_once`), records every due run in
//   schedule_runs, never overlaps two runs of one schedule, and starts each run as a normal
//   mission (same contract, budget, permission engine and approvals).
import type { Schedule, ScheduleEvent, ScheduleRun, ScheduleTrigger } from "@nova/shared";

export interface SchedulerDeps {
  /** Starts the mission of a run (plan + start with the schedule's contract); returns its id. */
  startMission(schedule: Schedule, runId: string): Promise<{ missionId: string }>;
  push(event: ScheduleEvent): void;
  now?: () => number;
}

export interface Scheduler {
  /** Applies missed-run policies, then arms the timers. */
  start(): void;
  stop(): void;
  /** Re-arms one schedule after create/update/pause/resume/remove. */
  reschedule(scheduleId: string): void;
  /** A run's mission reached a terminal (or suspended) state. */
  onMissionEnded(missionId: string, outcome: ScheduleRun["outcome"]): void;
  /** Schedules that will run while NOVA stays open (tray / quit warning). */
  activeCount(): number;
  nextDueAt(): number | null;
}

export type NextRunAt = (trigger: ScheduleTrigger, after: number) => number | null;
