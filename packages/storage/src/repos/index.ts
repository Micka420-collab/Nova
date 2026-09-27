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
  type ApprovalRecord,
  type ApprovalRepo,
  type ApprovalScopeValue,
  type ApprovalStatusValue,
  type NewApproval,
} from "./approvals";
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
