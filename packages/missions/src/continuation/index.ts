// L8 — "jusqu'à preuve" auto-continuation and the timeline (search, fork). Owned by lane L8.
// Runtime side: a `LoopContinuationHook` (../loop) bounded by the contract's
// `harness.autoContinue` (rounds + budget cap). Main side: `TimelineService` backs the
// `timeline.*` IPC group (storage: mission_events_fts, mission_links kind 'fork').
import type { MissionForkRequest, MissionPlanResult, TimelineHit, TimelineSearchRequest } from "@nova/shared";

export interface TimelineService {
  search(request: TimelineSearchRequest): Promise<TimelineHit[]>;
  fork(request: MissionForkRequest): Promise<MissionPlanResult>;
}
