// `timeline.*` IPC group and the main side of "jusqu'à preuve" (J2-B L8). Binds the pure cores of
// @nova/missions (`createTimelineService`, `createContinuationCore`) to SQLite (FTS search,
// mission links, missions/tasks/events, the cost ledger) and to the missions controller (plan,
// contract, journal). Every refusal becomes a typed ServiceError. No Electron import: tested in Node.
import {
  MissionError,
  createContinuationCore,
  createTimelineService as createTimelineCore,
  eventFromRecord,
  type LoopContinuationHook,
  type MissionController,
  type MissionEventInput,
} from "@nova/missions";
import { MissionForkRequestSchema, TimelineSearchRequestSchema, type MissionEvent } from "@nova/shared";
import { createMissionLinkRepo, createMissionRepo, createTimelineSearchRepo, type NovaStore } from "@nova/storage";
import type { MainApi } from "../api";
import { ServiceError } from "../service-error";

/** The missions side, resolved lazily (the missions service is created with these hooks). */
export type TimelineMissionsController = Pick<MissionController, "plan" | "contractOf" | "journal">;

export interface TimelineServiceDeps {
  store: NovaStore;
  missions(): TimelineMissionsController;
}

export interface TimelineMainService {
  api: MainApi["timeline"];
  /** Wire as `MainRuntimeHandlers.continuation` in the missions service's `connectRuntime`. */
  continuation: LoopContinuationHook;
  /**
   * Call with each event the runtime appends, BEFORE `MainRuntimeHandlers.appendEvent` stores it
   * (journals `continuation.stopped` proven/user/manual_only ahead of the terminal event).
   */
  beforeRuntimeEvent(event: MissionEventInput): void;
}

function toServiceError(error: unknown): unknown {
  if (error instanceof MissionError) return new ServiceError(error.code, error.message);
  return error;
}

export function createTimelineService(deps: TimelineServiceDeps): TimelineMainService {
  const missions = createMissionRepo(deps.store.db);
  const links = createMissionLinkRepo(deps.store.db);
  const search = createTimelineSearchRepo(deps.store.db);
  const events = (missionId: string, afterSeq = 0): MissionEvent[] => missions.listEvents(missionId, afterSeq).map(eventFromRecord);

  const timeline = createTimelineCore({
    search,
    missions: { get: (id) => missions.get(id), events: (id) => events(id) },
    contractOf: (id) => deps.missions().contractOf(id),
    plan: (request) => deps.missions().plan(request),
    links,
    journal: { append: (event) => deps.missions().journal.append(event) },
  });

  const continuation = createContinuationCore({
    contractOf: (id) => deps.missions().contractOf(id),
    tasks: (id) => missions.listTasks(id),
    events,
    // The day start only shapes the daily total, which the continuation cap does not read.
    spend: (id) => missions.cost.summary(id, 0),
    journal: { append: (event) => deps.missions().journal.append(event) },
  });

  return {
    api: {
      async search(request) {
        const parsed = TimelineSearchRequestSchema.safeParse(request);
        if (!parsed.success) throw new ServiceError("invalid_request", "invalid timeline search");
        return timeline.search(parsed.data);
      },
      async fork(request) {
        const parsed = MissionForkRequestSchema.safeParse(request);
        if (!parsed.success) throw new ServiceError("invalid_request", "invalid fork request");
        try {
          return await timeline.fork(parsed.data);
        } catch (error) {
          throw toServiceError(error);
        }
      },
    },
    continuation: continuation.hook,
    beforeRuntimeEvent: (event) => continuation.beforeRuntimeEvent(event),
  };
}
