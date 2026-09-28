// Scheduled missions (Pr5, J2-B L6): schedules and the history of their runs.
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  MissedRunPolicy,
  MissionContractInput,
  Schedule,
  ScheduleRun,
  ScheduleRunOutcome,
  ScheduleState,
  ScheduleTrigger,
} from "@nova/shared";
import { readJsonOrNull, readNumber, readNumberOrNull, readText, readTextOrNull, type Row } from "../sqlite";

export type NewSchedule = Omit<Schedule, "id" | "state" | "lastRunAt" | "createdAt" | "updatedAt">;

export type SchedulePatch = Partial<Pick<Schedule, "title" | "goal" | "mode" | "modelId" | "contract" | "trigger" | "missedPolicy">>;

export interface ScheduleRepo {
  create(input: NewSchedule): Schedule;
  get(id: string): Schedule | null;
  /** Oldest first; `workspaceId` null = every workspace. */
  list(workspaceId: string | null): Schedule[];
  /** Returns null when the schedule does not exist. `nextRunAt` is the caller's to recompute. */
  update(id: string, patch: SchedulePatch, nextRunAt: number | null): Schedule | null;
  setState(id: string, state: ScheduleState, nextRunAt: number | null): Schedule | null;
  /** After a run was recorded: stamps last_run_at and the next due time. */
  markRan(id: string, ranAt: number, nextRunAt: number | null): Schedule | null;
  /** Deletes the schedule and its runs (missions stay). */
  remove(id: string): boolean;
  /** Active schedules due at or before `at`, earliest first. */
  listDue(at: number): Schedule[];

  insertRun(input: { scheduleId: string; dueAt: number; outcome: ScheduleRunOutcome; missionId?: string | null; detail?: string | null }): ScheduleRun;
  /** Links the started mission (outcome `running`, started_at = now). */
  startRun(runId: string, missionId: string): ScheduleRun | null;
  finishRun(runId: string, outcome: Exclude<ScheduleRunOutcome, "running">, detail?: string | null): ScheduleRun | null;
  /** Newest first. */
  listRuns(scheduleId: string, limit: number): ScheduleRun[];
  runOfMission(missionId: string): ScheduleRun | null;
  /** Runs still `running` (crash recovery at startup). */
  listRunning(): ScheduleRun[];
  /** Runs of one schedule whose mission may still hold it (`running` or `suspended`), oldest first. */
  listOpenRuns(scheduleId: string): ScheduleRun[];
  /**
   * Keeps the newest `keep` runs of a schedule; returns the number removed. Open runs (`running`,
   * `suspended`) are never removed: they are how a run's mission end finds its row and how
   * overlaps are detected.
   */
  pruneRuns(scheduleId: string, keep: number): number;
}

function toSchedule(row: Row): Schedule {
  return {
    id: readText(row, "id"),
    workspaceId: readText(row, "workspace_id"),
    title: readText(row, "title"),
    goal: readText(row, "goal"),
    // Enum columns are guarded by CHECK constraints; JSON columns are written from typed values.
    mode: readText(row, "mode") as Schedule["mode"],
    modelId: readText(row, "model_id"),
    contract: readJsonOrNull<MissionContractInput>(row, "contract_json") as MissionContractInput,
    trigger: readJsonOrNull<ScheduleTrigger>(row, "trigger_json") as ScheduleTrigger,
    missedPolicy: readText(row, "missed_policy") as MissedRunPolicy,
    state: readText(row, "state") as ScheduleState,
    nextRunAt: readNumberOrNull(row, "next_run_at"),
    lastRunAt: readNumberOrNull(row, "last_run_at"),
    createdAt: readNumber(row, "created_at"),
    updatedAt: readNumber(row, "updated_at"),
  };
}

function toRun(row: Row): ScheduleRun {
  return {
    id: readText(row, "id"),
    scheduleId: readText(row, "schedule_id"),
    missionId: readTextOrNull(row, "mission_id"),
    dueAt: readNumber(row, "due_at"),
    startedAt: readNumberOrNull(row, "started_at"),
    endedAt: readNumberOrNull(row, "ended_at"),
    outcome: readText(row, "outcome") as ScheduleRunOutcome,
    detail: readTextOrNull(row, "detail"),
  };
}

export function createScheduleRepo(db: DatabaseSync, now: () => number = Date.now): ScheduleRepo {
  const get = (id: string): Schedule | null => {
    const row = db.prepare("SELECT * FROM schedules WHERE id = ?").get(id);
    return row ? toSchedule(row) : null;
  };
  const getRun = (id: string): ScheduleRun | null => {
    const row = db.prepare("SELECT * FROM schedule_runs WHERE id = ?").get(id);
    return row ? toRun(row) : null;
  };

  return {
    create(input) {
      const id = randomUUID();
      const time = now();
      db.prepare(
        `INSERT INTO schedules (id, workspace_id, title, goal, mode, model_id, contract_json, trigger_json,
           missed_policy, state, next_run_at, last_run_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, NULL, ?, ?)`,
      ).run(
        id,
        input.workspaceId,
        input.title,
        input.goal,
        input.mode,
        input.modelId,
        JSON.stringify(input.contract),
        JSON.stringify(input.trigger),
        input.missedPolicy,
        input.nextRunAt,
        time,
        time,
      );
      const created = get(id);
      if (!created) throw new Error("Created schedule not found");
      return created;
    },

    get,

    list(workspaceId) {
      const rows =
        workspaceId === null
          ? db.prepare("SELECT * FROM schedules ORDER BY created_at, id").all()
          : db.prepare("SELECT * FROM schedules WHERE workspace_id = ? ORDER BY created_at, id").all(workspaceId);
      return rows.map(toSchedule);
    },

    update(id, patch, nextRunAt) {
      const current = get(id);
      if (!current) return null;
      const next = { ...current, ...patch };
      db.prepare(
        `UPDATE schedules SET title = ?, goal = ?, mode = ?, model_id = ?, contract_json = ?, trigger_json = ?,
           missed_policy = ?, next_run_at = ?, updated_at = ? WHERE id = ?`,
      ).run(
        next.title,
        next.goal,
        next.mode,
        next.modelId,
        JSON.stringify(next.contract),
        JSON.stringify(next.trigger),
        next.missedPolicy,
        nextRunAt,
        now(),
        id,
      );
      return get(id);
    },

    setState(id, state, nextRunAt) {
      db.prepare("UPDATE schedules SET state = ?, next_run_at = ?, updated_at = ? WHERE id = ?").run(state, nextRunAt, now(), id);
      return get(id);
    },

    markRan(id, ranAt, nextRunAt) {
      db.prepare("UPDATE schedules SET last_run_at = ?, next_run_at = ?, updated_at = ? WHERE id = ?").run(ranAt, nextRunAt, now(), id);
      return get(id);
    },

    remove(id) {
      return Number(db.prepare("DELETE FROM schedules WHERE id = ?").run(id).changes) > 0;
    },

    listDue(at) {
      return db
        .prepare("SELECT * FROM schedules WHERE state = 'active' AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at, id")
        .all(at)
        .map(toSchedule);
    },

    insertRun(input) {
      const id = randomUUID();
      const missionId = input.missionId ?? null;
      const started = input.outcome === "running" ? now() : null;
      const ended = input.outcome === "running" ? null : now();
      db.prepare(
        `INSERT INTO schedule_runs (id, schedule_id, mission_id, due_at, started_at, ended_at, outcome, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, input.scheduleId, missionId, input.dueAt, started, ended, input.outcome, input.detail ?? null);
      const run = getRun(id);
      if (!run) throw new Error("Inserted schedule run not found");
      return run;
    },

    startRun(runId, missionId) {
      db.prepare(
        "UPDATE schedule_runs SET mission_id = ?, outcome = 'running', started_at = coalesce(started_at, ?), ended_at = NULL WHERE id = ?",
      ).run(missionId, now(), runId);
      return getRun(runId);
    },

    finishRun(runId, outcome, detail = null) {
      db.prepare("UPDATE schedule_runs SET outcome = ?, detail = ?, ended_at = ? WHERE id = ?").run(outcome, detail, now(), runId);
      return getRun(runId);
    },

    listRuns(scheduleId, limit) {
      return db
        .prepare("SELECT * FROM schedule_runs WHERE schedule_id = ? ORDER BY due_at DESC, rowid DESC LIMIT ?")
        .all(scheduleId, limit)
        .map(toRun);
    },

    runOfMission(missionId) {
      const row = db.prepare("SELECT * FROM schedule_runs WHERE mission_id = ?").get(missionId);
      return row ? toRun(row) : null;
    },

    listRunning() {
      return db.prepare("SELECT * FROM schedule_runs WHERE outcome = 'running' ORDER BY due_at").all().map(toRun);
    },

    listOpenRuns(scheduleId) {
      return db
        .prepare("SELECT * FROM schedule_runs WHERE schedule_id = ? AND outcome IN ('running', 'suspended') ORDER BY due_at, rowid")
        .all(scheduleId)
        .map(toRun);
    },

    pruneRuns(scheduleId, keep) {
      const result = db
        .prepare(
          `DELETE FROM schedule_runs WHERE schedule_id = ? AND outcome NOT IN ('running', 'suspended') AND id NOT IN
             (SELECT id FROM schedule_runs WHERE schedule_id = ? ORDER BY due_at DESC, rowid DESC LIMIT ?)`,
        )
        .run(scheduleId, scheduleId, keep);
      return Number(result.changes);
    },
  };
}
