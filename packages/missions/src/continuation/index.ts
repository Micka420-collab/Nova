// L8 — "jusqu'à preuve" auto-continuation and the timeline (search, fork). Owned by lane L8.
// - `createContinuationCore`: main side of the loop's continuation hook (wired as
//   `MainRuntimeHandlers.continuation`), bounded by the contract's `harness.autoContinue`
//   (rounds + spend cap inside the mission budget), journaling `continuation.*`.
// - `createTimelineService`: backs the `timeline.*` IPC group (storage: mission_events_fts,
//   mission_links kind 'fork').
export {
  continuationPrompt,
  createContinuationCore,
  type ContinuationCore,
  type ContinuationCoreDeps,
  type ContinuationSpend,
} from "./continuation";
export {
  TIMELINE_LIMITS,
  buildForkRecap,
  createTimelineService,
  eventText,
  excerptAt,
  matchOffset,
  type TimelineSearchRecordLike,
  type TimelineService,
  type TimelineServiceDeps,
} from "./timeline";
