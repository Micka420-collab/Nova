// Domain repositories over the migrated NOVA database (`NovaStore.db`).
//
// Pattern for feature work:
// - One module per domain (workspaces, missions, approvals, signals…), exporting a
//   `createXRepo(db: DatabaseSync, now = Date.now)` factory that returns plain methods: pure
//   functions of the handle, no caching, no hidden state.
// - Rows are mapped to @nova/shared types when they exist; otherwise to local record types
//   exported from here (camelCase fields, `null` for unknown, `_json` columns parsed).
//   Enum columns are guarded by CHECK constraints in `migrations.ts`, so reads cast them.
// - Multi-statement writes go through `withTransaction` (not reentrant: never nest repos calls
//   that each open one).
// - Never store secrets (reference `secrets.id` only) nor project file contents (relative paths
//   and hashes only; bytes live in dataDir). Schema changes are new migrations, never edits.
export {
  createApprovalRepo,
  type ApprovalFilter,
  type ApprovalRecord,
  type ApprovalRepo,
  type ApprovalScopeValue,
  type ApprovalStatusValue,
  type NewApproval,
} from "./approvals";
export {
  createAuditRepo,
  type AuditActorValue,
  type AuditDataSummary,
  type AuditDecisionValue,
  type AuditFilter,
  type AuditRecord,
  type AuditRepo,
  type NewAuditEntry,
} from "./audit";
export {
  createMissionRepo,
  type IsolationLevelValue,
  type MissionContractRecord,
  type MissionEventRecord,
  type MissionRecord,
  type MissionRepo,
  type MissionStateValue,
  type NewMission,
  type OperationClassValue,
  type WorkModeValue,
} from "./missions";
export { createPolicyRepo, type NewPolicy, type PolicyRepo } from "./policies";
export {
  createSignalRepo,
  type NewSignal,
  type SignalKindValue,
  type SignalRecord,
  type SignalRepo,
  type SignalStateValue,
} from "./signals";
export {
  createWorkspaceRepo,
  type InstructionFilesConsentValue,
  type PermissionProfileValue,
  type WorkspaceRecord,
  type WorkspaceRepo,
} from "./workspaces";
export { createArtifactRepo, type ArtifactKindValue, type ArtifactRecord, type ArtifactRepo, type NewArtifact } from "./artifacts";
export { createCheckpointRepo, type CheckpointRepo, type NewCheckpoint } from "./checkpoints";
export {
  createEditorStateRepo,
  EDITOR_STATE_MAX_CHARS,
  type EditorStateRecord,
  type EditorStateRepo,
} from "./editor-state";
export {
  createMcpRepo,
  type McpCachedTool,
  type McpRepo,
  type McpServerPatch,
  type McpToolPermissionRecord,
  type NewMcpServer,
} from "./mcp";
export {
  createSuggestionRepo,
  type NewSuggestion,
  type SuggestionRecord,
  type SuggestionRepo,
  type SuggestionStatusValue,
} from "./suggestions";
export {
  createWebCacheRepo,
  createWebSearchUsageRepo,
  type WebCacheRecord,
  type WebCacheRepo,
  type WebSearchUsageInput,
  type WebSearchUsageRepo,
} from "./web-cache";
export {
  createWebPolicyRepo,
  WEB_DEFAULT_RULE_PATTERN,
  WEB_FALLBACK_DEFAULT_ACTION,
  type WebPolicyRepo,
  type WebPolicyScopeWrite,
} from "./web-policy";
// J2-B "parité Harness"
export {
  createCompactionRepo,
  type CompactionRepo,
  type NewCompactionSummary,
} from "./compaction";
export {
  createMissionLinkRepo,
  type MissionLinkRepo,
  type NewMissionLink,
} from "./mission-links";
export {
  createScheduleRepo,
  type NewSchedule,
  type SchedulePatch,
  type ScheduleRepo,
} from "./schedules";
export {
  createSkillRepo,
  type InstalledSkillRecord,
  type NewInstalledSkill,
  type SkillEnablementRecord,
  type SkillRepo,
} from "./skills";
export {
  createTimelineSearchRepo,
  toFtsQuery,
  type TimelineSearchRecord,
  type TimelineSearchRepo,
} from "./timeline";
