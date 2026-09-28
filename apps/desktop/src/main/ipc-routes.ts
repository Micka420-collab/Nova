// IPC routing without Electron: channel -> schema-validated call -> IpcResult envelope.
// Handlers never throw across IPC; every failure becomes a typed IpcError.
import { RuntimeError, type RuntimeErrorCode, type RuntimeLogger } from "@nova/agent-runtime";
import { ProviderError } from "@nova/providers";
import {
  ApprovalDecideRequestSchema,
  ApprovalsListRequestSchema,
  AuditListRequestSchema,
  CatalogRequestSchema,
  CheckpointApplyMergeRequestSchema,
  CheckpointCreateRequestSchema,
  CheckpointMergeRequestSchema,
  CheckpointRestoreAllRequestSchema,
  CheckpointRestoreFileRequestSchema,
  CheckpointsListRequestSchema,
  CompanionActRequestSchema,
  CompanionQuietRequestSchema,
  CompanionStateRequestSchema,
  CompanionWatchRequestSchema,
  EditorStateSetRequestSchema,
  FileWriteRequestSchema,
  FilesCreateRequestSchema,
  FilesListRequestSchema,
  FilesMoveRequestSchema,
  FilesReadRequestSchema,
  FilesTrashRequestSchema,
  GitDiffRequestSchema,
  McpImportProjectRequestSchema,
  McpListRequestSchema,
  McpServerIdRequestSchema,
  McpServerInputSchema,
  McpServerUpdateRequestSchema,
  McpSetToolPermissionRequestSchema,
  McpToolsRequestSchema,
  MissionGetRequestSchema,
  MissionIdRequestSchema,
  MissionPlanRequestSchema,
  MissionResumeRequestSchema,
  MissionStartRequestSchema,
  MissionsListRequestSchema,
  PermissionRevokeRequestSchema,
  PermissionRulesRequestSchema,
  PermissionsProfileRequestSchema,
  PermissionsSetProfileRequestSchema,
  ReviewDecideRequestSchema,
  SearchFilesRequestSchema,
  SearchTextRequestSchema,
  TerminalCreateRequestSchema,
  TerminalListRequestSchema,
  TerminalResizeRequestSchema,
  TerminalSessionRequestSchema,
  WebPolicyGetRequestSchema,
  WebPolicySetRequestSchema,
  WorkspaceConsentRequestSchema,
  WorkspaceFactsRequestSchema,
  WorkspaceIdRequestSchema,
  WorkspaceRecentRequestSchema,
  AutopilotClassifyRequestSchema,
  CompactRequestSchema,
  CompactionDecideRequestSchema,
  CompactionsListRequestSchema,
  ContextUsageRequestSchema,
  HandoffRequestSchema,
  MissionForkRequestSchema,
  MissionTreeRequestSchema,
  ProcessIdRequestSchema,
  ProcessOutputRequestSchema,
  ProcessesListRequestSchema,
  ScheduleCreateRequestSchema,
  ScheduleIdRequestSchema,
  ScheduleRunsRequestSchema,
  ScheduleSetPausedRequestSchema,
  ScheduleUpdateRequestSchema,
  SchedulesListRequestSchema,
  SkillGetRequestSchema,
  SkillInstallRequestSchema,
  SkillPreviewRequestSchema,
  SkillSetEnabledRequestSchema,
  SkillUninstallRequestSchema,
  SkillsListRequestSchema,
  SubMissionIdRequestSchema,
  TimelineSearchRequestSchema,
  ChatRetryRequestSchema,
  ChatSendRequestSchema,
  ChatStopRequestSchema,
  ConversationIdRequestSchema,
  IPC_CHANNELS,
  ListConversationsRequestSchema,
  OpenExternalRequestSchema,
  ProviderRequestSchema,
  RenameConversationRequestSchema,
  SetKeyRequestSchema,
  SettingsPatchSchema,
  redactSecrets,
  type IpcChannel,
  type IpcError,
  type IpcErrorCode,
  type IpcResult,
} from "@nova/shared";
import { z } from "zod";
import type { MainApi } from "./api";
import { describeError } from "./logger";
import { ServiceError } from "./service-error";
import { VaultError } from "./vault";

export interface IpcRoute {
  channel: IpcChannel;
  handle(payload: unknown): Promise<IpcResult<unknown>>;
}

const RUNTIME_CODES: Readonly<Record<RuntimeErrorCode, IpcErrorCode>> = {
  no_key: "no_key",
  not_found: "not_found",
  conflict: "conflict",
  invalid_state: "conflict",
};

/** Maps any failure to an IpcError. Messages are short, fixed or redacted; payloads are never echoed. */
export function toIpcError(error: unknown): IpcError {
  if (error instanceof ProviderError) {
    return { code: "provider", message: `Provider error: ${error.info.code}`, providerError: error.info };
  }
  if (error instanceof RuntimeError) return { code: RUNTIME_CODES[error.code], message: error.message };
  if (error instanceof ServiceError) return { code: error.code, message: error.message };
  if (error instanceof VaultError) return { code: "vault_unavailable", message: error.message };
  if (error instanceof z.ZodError) return { code: "invalid_request", message: "Invalid request" };
  return { code: "internal", message: "Internal error" };
}

/** Field paths only: issue messages and values may quote the payload (keys included). */
function describeIssues(error: z.ZodError): string {
  const paths = [...new Set(error.issues.map((issue) => issue.path.map(String).join(".") || "(root)"))];
  return `Invalid request: ${paths.join(", ")}`.slice(0, 200);
}

const NoPayloadSchema = z.undefined();
const C = IPC_CHANNELS;

export function buildIpcRoutes(api: MainApi, logger: RuntimeLogger): IpcRoute[] {
  const route = <S extends z.ZodType, R>(
    channel: IpcChannel,
    schema: S,
    run: (req: z.output<S>) => Promise<R>,
  ): IpcRoute => ({
    channel,
    handle: async (payload) => {
      const parsed = schema.safeParse(payload);
      if (!parsed.success) {
        const message = describeIssues(parsed.error);
        logger.warn("ipc request rejected", { channel, reason: message });
        return { ok: false, error: { code: "invalid_request", message } };
      }
      try {
        return { ok: true, value: await run(parsed.data) };
      } catch (error) {
        const ipcError = toIpcError(error);
        if (ipcError.code === "internal") {
          logger.error("ipc handler failed", { channel, error: redactSecrets(describeError(error)) });
        } else {
          logger.info("ipc request refused", { channel, code: ipcError.code, provider: ipcError.providerError?.code });
        }
        return { ok: false, error: ipcError };
      }
    },
  });

  return [
    route(IPC_CHANNELS.appInfo, NoPayloadSchema, () => api.app.info()),
    route(IPC_CHANNELS.appOpenExternal, OpenExternalRequestSchema, (req) => api.app.openExternal(req)),
    route(IPC_CHANNELS.settingsGet, NoPayloadSchema, () => api.settings.get()),
    route(IPC_CHANNELS.settingsUpdate, SettingsPatchSchema, (patch) => api.settings.update(patch)),
    route(IPC_CHANNELS.connectionGet, ProviderRequestSchema, (req) => api.connection.get(req)),
    route(IPC_CHANNELS.connectionSetKey, SetKeyRequestSchema, (req) => api.connection.setKey(req)),
    route(IPC_CHANNELS.connectionTest, ProviderRequestSchema, (req) => api.connection.test(req)),
    route(IPC_CHANNELS.connectionRemove, ProviderRequestSchema, (req) => api.connection.remove(req)),
    route(IPC_CHANNELS.modelsCatalog, CatalogRequestSchema, (req) => api.models.catalog(req)),
    route(IPC_CHANNELS.conversationsList, ListConversationsRequestSchema, (req) => api.conversations.list(req)),
    route(IPC_CHANNELS.conversationsGet, ConversationIdRequestSchema, (req) => api.conversations.get(req)),
    route(IPC_CHANNELS.conversationsRename, RenameConversationRequestSchema, (req) =>
      api.conversations.rename(req),
    ),
    route(IPC_CHANNELS.conversationsDelete, ConversationIdRequestSchema, (req) => api.conversations.delete(req)),
    route(IPC_CHANNELS.chatSend, ChatSendRequestSchema, (req) => api.chat.send(req)),
    route(IPC_CHANNELS.chatStop, ChatStopRequestSchema, (req) => api.chat.stop(req)),
    route(IPC_CHANNELS.chatRetry, ChatRetryRequestSchema, (req) => api.chat.retry(req)),
    route(IPC_CHANNELS.chatActive, NoPayloadSchema, () => api.chat.active()),

    // J2-A
    route(C.workspaceOpen, NoPayloadSchema, () => api.workspace.open()),
    route(C.workspaceRecent, WorkspaceRecentRequestSchema, (req) => api.workspace.recent(req)),
    route(C.workspaceFacts, WorkspaceFactsRequestSchema, (req) => api.workspace.facts(req)),
    route(C.workspaceClose, WorkspaceIdRequestSchema, (req) => api.workspace.close(req)),
    route(C.workspaceSetInstructionConsent, WorkspaceConsentRequestSchema, (req) =>
      api.workspace.setInstructionConsent(req),
    ),
    route(C.workspaceReopen, WorkspaceIdRequestSchema, (req) => api.workspace.reopen(req)),
    route(C.workspaceGetEditorState, WorkspaceIdRequestSchema, (req) => api.workspace.getEditorState(req)),
    route(C.workspaceSetEditorState, EditorStateSetRequestSchema, (req) => api.workspace.setEditorState(req)),
    route(C.filesList, FilesListRequestSchema, (req) => api.files.list(req)),
    route(C.filesRead, FilesReadRequestSchema, (req) => api.files.read(req)),
    route(C.filesWrite, FileWriteRequestSchema, (req) => api.files.write(req)),
    route(C.filesCreate, FilesCreateRequestSchema, (req) => api.files.create(req)),
    route(C.filesMove, FilesMoveRequestSchema, (req) => api.files.move(req)),
    route(C.filesTrash, FilesTrashRequestSchema, (req) => api.files.trash(req)),
    route(C.searchText, SearchTextRequestSchema, (req) => api.search.text(req)),
    route(C.searchFiles, SearchFilesRequestSchema, (req) => api.search.files(req)),
    route(C.terminalCreate, TerminalCreateRequestSchema, (req) => api.terminal.create(req)),
    route(C.terminalList, TerminalListRequestSchema, (req) => api.terminal.list(req)),
    route(C.terminalAttach, TerminalSessionRequestSchema, (req) => api.terminal.attach(req)),
    route(C.terminalResize, TerminalResizeRequestSchema, (req) => api.terminal.resize(req)),
    route(C.terminalKill, TerminalSessionRequestSchema, (req) => api.terminal.kill(req)),
    route(C.terminalTakeOver, TerminalSessionRequestSchema, (req) => api.terminal.takeOver(req)),
    route(C.missionsPlan, MissionPlanRequestSchema, (req) => api.missions.plan(req)),
    route(C.missionsStart, MissionStartRequestSchema, (req) => api.missions.start(req)),
    route(C.missionsPause, MissionIdRequestSchema, (req) => api.missions.pause(req)),
    route(C.missionsResume, MissionResumeRequestSchema, (req) => api.missions.resume(req)),
    route(C.missionsStop, MissionIdRequestSchema, (req) => api.missions.stop(req)),
    route(C.missionsList, MissionsListRequestSchema, (req) => api.missions.list(req)),
    route(C.missionsGet, MissionGetRequestSchema, (req) => api.missions.get(req)),
    route(C.missionsReview, ReviewDecideRequestSchema, (req) => api.missions.review(req)),
    route(C.missionsDiff, MissionIdRequestSchema, (req) => api.missions.diff(req)),
    route(C.approvalsList, ApprovalsListRequestSchema, (req) => api.approvals.list(req)),
    route(C.approvalsDecide, ApprovalDecideRequestSchema, (req) => api.approvals.decide(req)),
    route(C.permissionsGetProfile, PermissionsProfileRequestSchema, (req) => api.permissions.getProfile(req)),
    route(C.permissionsSetProfile, PermissionsSetProfileRequestSchema, (req) => api.permissions.setProfile(req)),
    route(C.permissionsListRules, PermissionRulesRequestSchema, (req) => api.permissions.listRules(req)),
    route(C.permissionsRevokeRules, PermissionRevokeRequestSchema, (req) => api.permissions.revokeRules(req)),
    route(C.auditList, AuditListRequestSchema, (req) => api.audit.list(req)),
    route(C.gitStatus, WorkspaceIdRequestSchema, (req) => api.git.status(req)),
    route(C.gitDiff, GitDiffRequestSchema, (req) => api.git.diff(req)),
    route(C.mcpList, McpListRequestSchema, (req) => api.mcp.list(req)),
    route(C.mcpAdd, McpServerInputSchema, (req) => api.mcp.add(req)),
    route(C.mcpUpdate, McpServerUpdateRequestSchema, (req) => api.mcp.update(req)),
    route(C.mcpRemove, McpServerIdRequestSchema, (req) => api.mcp.remove(req)),
    route(C.mcpTest, McpServerIdRequestSchema, (req) => api.mcp.test(req)),
    route(C.mcpTools, McpToolsRequestSchema, (req) => api.mcp.tools(req)),
    route(C.mcpSetToolPermission, McpSetToolPermissionRequestSchema, (req) => api.mcp.setToolPermission(req)),
    route(C.mcpLogs, McpServerIdRequestSchema, (req) => api.mcp.logs(req)),
    route(C.mcpImportProject, McpImportProjectRequestSchema, (req) => api.mcp.importProject(req)),
    route(C.webGetPolicy, WebPolicyGetRequestSchema, (req) => api.web.getPolicy(req)),
    route(C.webSetPolicy, WebPolicySetRequestSchema, (req) => api.web.setPolicy(req)),
    route(C.companionState, CompanionStateRequestSchema, (req) => api.companion.state(req)),
    route(C.companionAct, CompanionActRequestSchema, (req) => api.companion.act(req)),
    route(C.companionWatch, CompanionWatchRequestSchema, (req) => api.companion.watch(req)),
    route(C.companionSetQuiet, CompanionQuietRequestSchema, (req) => api.companion.setQuiet(req)),
    route(C.companionNotices, NoPayloadSchema, () => api.companion.notices()),
    route(C.checkpointsList, CheckpointsListRequestSchema, (req) => api.checkpoints.list(req)),
    route(C.checkpointsRestoreFile, CheckpointRestoreFileRequestSchema, (req) => api.checkpoints.restoreFile(req)),
    route(C.checkpointsRestoreAll, CheckpointRestoreAllRequestSchema, (req) => api.checkpoints.restoreAll(req)),
    route(C.checkpointsCreate, CheckpointCreateRequestSchema, (req) => api.checkpoints.create(req)),
    route(C.checkpointsProposeMerge, CheckpointMergeRequestSchema, (req) => api.checkpoints.proposeMerge(req)),
    route(C.checkpointsApplyMerge, CheckpointApplyMergeRequestSchema, (req) => api.checkpoints.applyMerge(req)),

    // J2-B
    route(C.processesList, ProcessesListRequestSchema, (req) => api.processes.list(req)),
    route(C.processesOutput, ProcessOutputRequestSchema, (req) => api.processes.output(req)),
    route(C.processesStop, ProcessIdRequestSchema, (req) => api.processes.stop(req)),
    route(C.contextUsage, ContextUsageRequestSchema, (req) => api.context.usage(req)),
    route(C.contextCompact, CompactRequestSchema, (req) => api.context.compact(req)),
    route(C.contextDecide, CompactionDecideRequestSchema, (req) => api.context.decide(req)),
    route(C.contextList, CompactionsListRequestSchema, (req) => api.context.list(req)),
    route(C.contextHandoff, HandoffRequestSchema, (req) => api.context.handoff(req)),
    route(C.skillsList, SkillsListRequestSchema, (req) => api.skills.list(req)),
    route(C.skillsGet, SkillGetRequestSchema, (req) => api.skills.get(req)),
    route(C.skillsPreview, SkillPreviewRequestSchema, (req) => api.skills.preview(req)),
    route(C.skillsInstall, SkillInstallRequestSchema, (req) => api.skills.install(req)),
    route(C.skillsUninstall, SkillUninstallRequestSchema, (req) => api.skills.uninstall(req)),
    route(C.skillsSetEnabled, SkillSetEnabledRequestSchema, (req) => api.skills.setEnabled(req)),
    route(C.submissionsTree, MissionTreeRequestSchema, (req) => api.submissions.tree(req)),
    route(C.submissionsIntegrate, SubMissionIdRequestSchema, (req) => api.submissions.integrate(req)),
    route(C.submissionsDiscard, SubMissionIdRequestSchema, (req) => api.submissions.discard(req)),
    route(C.schedulesList, SchedulesListRequestSchema, (req) => api.schedules.list(req)),
    route(C.schedulesCreate, ScheduleCreateRequestSchema, (req) => api.schedules.create(req)),
    route(C.schedulesUpdate, ScheduleUpdateRequestSchema, (req) => api.schedules.update(req)),
    route(C.schedulesSetPaused, ScheduleSetPausedRequestSchema, (req) => api.schedules.setPaused(req)),
    route(C.schedulesRemove, ScheduleIdRequestSchema, (req) => api.schedules.remove(req)),
    route(C.schedulesRuns, ScheduleRunsRequestSchema, (req) => api.schedules.runs(req)),
    route(C.desktopState, NoPayloadSchema, () => api.desktop.state()),
    route(C.autopilotClassify, AutopilotClassifyRequestSchema, (req) => api.autopilot.classify(req)),
    route(C.timelineSearch, TimelineSearchRequestSchema, (req) => api.timeline.search(req)),
    route(C.timelineFork, MissionForkRequestSchema, (req) => api.timeline.fork(req)),
  ];
}
