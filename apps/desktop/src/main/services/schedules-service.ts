// `schedules.*` IPC group (Pr5, J2-B L6): CRUD of schedules over the v6 repo, the scheduler of
// @nova/scheduler, and the start of each run as a NORMAL mission: `missions.plan` then
// `missions.start` with the schedule's contract (same budget, permission engine and approvals —
// an `ask` waits for a human, nothing is auto-approved at night). Runs happen only while NOVA
// runs; a run is tracked to its mission's end through `onMissionEvent`. No Electron import: the
// timers and the clock are injectable, so this module is tested in Node.
import type { RuntimeLogger } from "@nova/agent-runtime";
import { checkTrigger, createScheduler, nextRunAt, type Scheduler, type SchedulerDeps } from "@nova/scheduler";
import type { MissionEvent, MissionState, Schedule, ScheduleEvent, ScheduleTrigger } from "@nova/shared";
import type { ScheduleRepo } from "@nova/storage";
import type { MainApi } from "../api";
import { describeError } from "../logger";
import { ServiceError } from "../service-error";

export interface SchedulesServiceDeps {
  repo: ScheduleRepo;
  /** The missions group (`missionsService.api`): a run is a mission like any other. */
  missions: Pick<MainApi["missions"], "plan" | "start" | "stop">;
  /** Current state of a mission (mission repo); null when it does not exist. */
  missionState(missionId: string): MissionState | null;
  workspaceExists(workspaceId: string): boolean;
  /** Catalog capability; `false` refuses the schedule up front (a mission needs tools). null = unknown. */
  supportsTools?(modelId: string): boolean | null;
  /**
   * What is left of today's daily cap (USD); null = no cap. A run whose contract budget exceeds it
   * is recorded `skipped_budget` instead of starting.
   */
  dailyRemainingUsd(): number | null;
  now?: () => number;
  setTimer?: SchedulerDeps["setTimer"];
  clearTimer?: SchedulerDeps["clearTimer"];
  logger?: RuntimeLogger;
}

export interface SchedulesService {
  api: MainApi["schedules"];
  /** Push to the renderer on IPC_CHANNELS.schedulesEvent. */
  onEvent(listener: (event: ScheduleEvent) => void): () => void;
  /** Wire to the missions push: follows each run's mission to its end. */
  onMissionEvent(event: MissionEvent): void;
  /** After `missions.controller.recoverInterrupted()`: settles open runs, applies missed-run policies. */
  start(): void;
  stop(): void;
  /** Counters for the tray and the quit warning (L7). */
  activeCount(): number;
  nextDueAt(): number | null;
}

function invalidTrigger(trigger: ScheduleTrigger, now: number): ServiceError | null {
  const check = checkTrigger(trigger, now);
  if (check.ok) return null;
  return new ServiceError("invalid_request", check.reason === "invalid_cron" ? `invalid cron: ${check.detail}` : `schedule never runs: ${check.detail}`);
}

export function createSchedulesService(deps: SchedulesServiceDeps): SchedulesService {
  const now = deps.now ?? Date.now;
  const listeners = new Set<(event: ScheduleEvent) => void>();
  const emit = (event: ScheduleEvent): void => {
    for (const listener of listeners) listener(event);
  };

  const scheduler: Scheduler = createScheduler({
    store: deps.repo,
    async startMission(schedule) {
      const planned = await deps.missions.plan({
        workspaceId: schedule.workspaceId,
        conversationId: null,
        goal: schedule.goal,
        mode: schedule.mode,
        modelId: schedule.modelId,
        contract: schedule.contract,
      });
      const missionId = planned.mission.id;
      try {
        await deps.missions.start({ missionId, tasks: null, contract: schedule.contract });
      } catch (error) {
        // A planned mission that could not start is cancelled, never left `ready` forever.
        await deps.missions.stop({ missionId }).catch(() => undefined);
        throw error;
      }
      return { missionId };
    },
    missionState: deps.missionState,
    canAfford(schedule) {
      const remaining = deps.dailyRemainingUsd();
      return remaining === null || schedule.contract.budgetUsd <= remaining;
    },
    push: emit,
    now,
    ...(deps.setTimer ? { setTimer: deps.setTimer } : {}),
    ...(deps.clearTimer ? { clearTimer: deps.clearTimer } : {}),
    onError: (message, error) => deps.logger?.warn(message, { error: describeError(error) }),
  });

  const existing = (scheduleId: string): Schedule => {
    const schedule = deps.repo.get(scheduleId);
    if (!schedule) throw new ServiceError("not_found", "Schedule not found");
    return schedule;
  };
  const checkModel = (modelId: string): void => {
    if (deps.supportsTools?.(modelId) === false) throw new ServiceError("invalid_request", "this model does not support tool calling");
  };
  const changed = (schedule: Schedule | null): Schedule => {
    if (!schedule) throw new ServiceError("not_found", "Schedule not found");
    emit({ type: "schedule.updated", schedule });
    scheduler.reschedule(schedule.id);
    return schedule;
  };

  return {
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onMissionEvent(event) {
      switch (event.type) {
        case "mission.succeeded":
          scheduler.onMissionEnded(event.missionId, "succeeded");
          return;
        case "mission.failed":
          scheduler.onMissionEnded(event.missionId, "failed");
          return;
        case "mission.cancelled":
          scheduler.onMissionEnded(event.missionId, "cancelled");
          return;
        case "mission.suspended":
          scheduler.onMissionEnded(event.missionId, "suspended");
          return;
        case "mission.resumed":
          scheduler.onMissionResumed(event.missionId);
          return;
        default:
          return;
      }
    },
    start: () => scheduler.start(),
    stop: () => scheduler.stop(),
    activeCount: () => scheduler.activeCount(),
    nextDueAt: () => scheduler.nextDueAt(),
    api: {
      list: async ({ workspaceId }) => deps.repo.list(workspaceId),

      async create(req) {
        if (!deps.workspaceExists(req.workspaceId)) throw new ServiceError("not_found", "Workspace not found");
        const time = now();
        const invalid = invalidTrigger(req.trigger, time);
        if (invalid) throw invalid;
        checkModel(req.modelId);
        return changed(deps.repo.create({ ...req, nextRunAt: nextRunAt(req.trigger, time) }));
      },

      async update({ scheduleId, patch }) {
        const current = existing(scheduleId);
        const time = now();
        if (patch.modelId !== undefined) checkModel(patch.modelId);
        if (patch.trigger === undefined) return changed(deps.repo.update(scheduleId, patch, current.nextRunAt));
        const invalid = invalidTrigger(patch.trigger, time);
        if (invalid) throw invalid;
        // A new trigger re-arms from now; a paused schedule stays paused, a completed one resumes.
        if (current.state === "paused") return changed(deps.repo.update(scheduleId, patch, null));
        const next = nextRunAt(patch.trigger, time);
        const updated = deps.repo.update(scheduleId, patch, next);
        return changed(current.state === "completed" ? deps.repo.setState(scheduleId, "active", next) : updated);
      },

      async setPaused({ scheduleId, paused }) {
        const current = existing(scheduleId);
        if (current.state === "completed") throw new ServiceError("conflict", "schedule is completed");
        if (paused) return changed(current.state === "paused" ? current : deps.repo.setState(scheduleId, "paused", null));
        if (current.state === "active") return current;
        // Resume: due times that passed while paused are not caught up (the pause was explicit).
        const next = nextRunAt(current.trigger, now());
        return changed(deps.repo.setState(scheduleId, next === null ? "completed" : "active", next));
      },

      async remove({ scheduleId }) {
        existing(scheduleId);
        // Missions of past runs stay; a run in progress continues as a normal mission.
        deps.repo.remove(scheduleId);
        emit({ type: "schedule.removed", scheduleId });
        scheduler.reschedule(scheduleId);
      },

      async runs({ scheduleId, limit }) {
        existing(scheduleId);
        return deps.repo.listRuns(scheduleId, limit);
      },
    },
  };
}
