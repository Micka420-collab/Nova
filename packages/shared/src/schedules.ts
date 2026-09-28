// J2-B L6 (Pr5): scheduled missions. A schedule stores a mission template (goal, mode, model,
// contract with its budget) and a trigger. Runs happen only while NOVA runs (the tray keeps it
// alive when the window is closed, L7); a run due while NOVA was not running follows the
// schedule's explicit missed-run policy. Each run is a normal mission (same contract, same
// permission engine, same approvals: nobody approves at night, so an `ask` waits or expires).
// A run never overlaps the previous one of the same schedule (`skipped_overlap`).
import { z } from "zod";
import { EntityIdSchema, ModelIdSchema } from "./ids";
import { MissionContractInputSchema, WORK_MODES, type MissionContractInput, type WorkMode } from "./missions";

export const SCHEDULE_LIMITS = {
  minIntervalMinutes: 1,
  maxIntervalMinutes: 60 * 24 * 31,
  titleMaxChars: 120,
  goalMaxChars: 20_000,
  /** Runs kept per schedule in the history. */
  historyMax: 500,
} as const;

/** Whether `value` is an IANA time zone known to this runtime (Intl). */
export function isIanaTimeZone(value: string): boolean {
  if (!/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*$/.test(value) && value !== "UTC") return false;
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: value }).resolvedOptions().timeZone.length > 0;
  } catch {
    return false;
  }
}

export const TimeZoneSchema = z.string().min(1).max(64).refine(isIanaTimeZone, "fuseau horaire inconnu");
/** Local wall-clock time "HH:MM" (24 h). */
export const LocalTimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "heure invalide");
/** Five-field cron (minute hour day-of-month month day-of-week); semantics checked by the scheduler. */
export const CronExpressionSchema = z
  .string()
  .trim()
  .max(120)
  .regex(/^\S+(\s+\S+){4}$/, "expression cron invalide (5 champs)");

export const ScheduleTriggerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("once"), at: z.int().min(0) }),
  z.object({
    kind: z.literal("interval"),
    everyMinutes: z.int().min(SCHEDULE_LIMITS.minIntervalMinutes).max(SCHEDULE_LIMITS.maxIntervalMinutes),
  }),
  z.object({ kind: z.literal("daily"), time: LocalTimeSchema, timeZone: TimeZoneSchema }),
  z.object({
    kind: z.literal("weekly"),
    /** 0 = Sunday … 6 = Saturday. */
    days: z.array(z.int().min(0).max(6)).min(1).max(7),
    time: LocalTimeSchema,
    timeZone: TimeZoneSchema,
  }),
  z.object({ kind: z.literal("cron"), expression: CronExpressionSchema, timeZone: TimeZoneSchema }),
]);
export type ScheduleTrigger = z.infer<typeof ScheduleTriggerSchema>;

/**
 * - `skip`: runs missed while NOVA was closed are recorded as `skipped_missed`, none is started.
 * - `run_once`: at most ONE catch-up run at startup, whatever the number missed.
 */
export const MISSED_RUN_POLICIES = ["skip", "run_once"] as const;
export type MissedRunPolicy = (typeof MISSED_RUN_POLICIES)[number];

export type ScheduleState = "active" | "paused" | "completed";

/** Modes a schedule may start (discuss has no mission). */
export const SCHEDULABLE_MODES = WORK_MODES.filter((mode): mode is Exclude<WorkMode, "discuss"> => mode !== "discuss");

export interface Schedule {
  id: string;
  workspaceId: string;
  title: string;
  goal: string;
  mode: Exclude<WorkMode, "discuss">;
  modelId: string;
  /** Contract (and budget) of every run. */
  contract: MissionContractInput;
  trigger: ScheduleTrigger;
  missedPolicy: MissedRunPolicy;
  state: ScheduleState;
  /** Next due time; null when paused, completed or not computable. */
  nextRunAt: number | null;
  lastRunAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export type ScheduleRunOutcome =
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "suspended"
  | "skipped_missed"
  | "skipped_overlap"
  | "skipped_budget"
  | "error";

export interface ScheduleRun {
  id: string;
  scheduleId: string;
  /** The mission started for this run; null when skipped or failed before starting. */
  missionId: string | null;
  dueAt: number;
  startedAt: number | null;
  endedAt: number | null;
  outcome: ScheduleRunOutcome;
  /** Short English code/detail (never content); the renderer picks the French copy. */
  detail: string | null;
}

const scheduleFields = {
  title: z.string().trim().min(1).max(SCHEDULE_LIMITS.titleMaxChars),
  goal: z.string().trim().min(1).max(SCHEDULE_LIMITS.goalMaxChars),
  mode: z.enum(SCHEDULABLE_MODES),
  modelId: ModelIdSchema,
  contract: MissionContractInputSchema,
  trigger: ScheduleTriggerSchema,
  missedPolicy: z.enum(MISSED_RUN_POLICIES),
};

export const SchedulesListRequestSchema = z.object({ workspaceId: EntityIdSchema.nullable() });
export const ScheduleCreateRequestSchema = z.object({ workspaceId: EntityIdSchema, ...scheduleFields });
export const ScheduleUpdateRequestSchema = z.object({
  scheduleId: EntityIdSchema,
  patch: z.object(scheduleFields).partial().strict(),
});
export const ScheduleIdRequestSchema = z.object({ scheduleId: EntityIdSchema });
export const ScheduleSetPausedRequestSchema = z.object({ scheduleId: EntityIdSchema, paused: z.boolean() });
export const ScheduleRunsRequestSchema = z.object({
  scheduleId: EntityIdSchema,
  limit: z.int().min(1).max(SCHEDULE_LIMITS.historyMax),
});

export type SchedulesListRequest = z.infer<typeof SchedulesListRequestSchema>;
export type ScheduleCreateRequest = z.infer<typeof ScheduleCreateRequestSchema>;
export type ScheduleUpdateRequest = z.infer<typeof ScheduleUpdateRequestSchema>;
export type ScheduleIdRequest = z.infer<typeof ScheduleIdRequestSchema>;
export type ScheduleSetPausedRequest = z.infer<typeof ScheduleSetPausedRequestSchema>;
export type ScheduleRunsRequest = z.infer<typeof ScheduleRunsRequestSchema>;

/** Pushed on `schedules.onEvent`. */
export type ScheduleEvent =
  | { type: "schedule.updated"; schedule: Schedule }
  | { type: "schedule.removed"; scheduleId: string }
  | { type: "schedule.run"; run: ScheduleRun };
