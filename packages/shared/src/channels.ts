// IPC channel names. Kept dependency-free so the sandboxed preload bundle stays minimal.
export const IPC_CHANNELS = {
  appInfo: "nova:app:info",
  appOpenExternal: "nova:app:open-external",
  settingsGet: "nova:settings:get",
  settingsUpdate: "nova:settings:update",
  connectionGet: "nova:connection:get",
  connectionSetKey: "nova:connection:set-key",
  connectionTest: "nova:connection:test",
  connectionRemove: "nova:connection:remove",
  modelsCatalog: "nova:models:catalog",
  conversationsList: "nova:conversations:list",
  conversationsGet: "nova:conversations:get",
  conversationsRename: "nova:conversations:rename",
  conversationsDelete: "nova:conversations:delete",
  chatSend: "nova:chat:send",
  chatStop: "nova:chat:stop",
  chatRetry: "nova:chat:retry",
  chatActive: "nova:chat:active",
  /** main -> renderer push channel. */
  chatEvent: "nova:chat:event",

  // J2-A "L'atelier s'ouvre"
  workspaceOpen: "nova:workspace:open",
  workspaceRecent: "nova:workspace:recent",
  workspaceFacts: "nova:workspace:facts",
  workspaceClose: "nova:workspace:close",
  workspaceSetInstructionConsent: "nova:workspace:set-instruction-consent",
  workspaceReopen: "nova:workspace:reopen",
  workspaceGetEditorState: "nova:workspace:get-editor-state",
  workspaceSetEditorState: "nova:workspace:set-editor-state",
  filesList: "nova:files:list",
  filesRead: "nova:files:read",
  filesWrite: "nova:files:write",
  filesCreate: "nova:files:create",
  filesMove: "nova:files:move",
  filesTrash: "nova:files:trash",
  /** main -> renderer push channel (FilesEvent). */
  filesEvent: "nova:files:event",
  searchText: "nova:search:text",
  searchFiles: "nova:search:files",
  terminalCreate: "nova:terminal:create",
  terminalList: "nova:terminal:list",
  terminalAttach: "nova:terminal:attach",
  terminalResize: "nova:terminal:resize",
  terminalKill: "nova:terminal:kill",
  terminalTakeOver: "nova:terminal:take-over",
  /** main -> renderer push channel (TerminalEvent). */
  terminalEvent: "nova:terminal:event",
  missionsPlan: "nova:missions:plan",
  missionsStart: "nova:missions:start",
  missionsPause: "nova:missions:pause",
  missionsResume: "nova:missions:resume",
  missionsStop: "nova:missions:stop",
  missionsList: "nova:missions:list",
  missionsGet: "nova:missions:get",
  missionsReview: "nova:missions:review",
  missionsDiff: "nova:missions:diff",
  /** main -> renderer push channel (MissionEvent). */
  missionsEvent: "nova:missions:event",
  approvalsList: "nova:approvals:list",
  approvalsDecide: "nova:approvals:decide",
  /** main -> renderer push channel (ApprovalEvent). */
  approvalsEvent: "nova:approvals:event",
  permissionsGetProfile: "nova:permissions:get-profile",
  permissionsSetProfile: "nova:permissions:set-profile",
  permissionsListRules: "nova:permissions:list-rules",
  permissionsRevokeRules: "nova:permissions:revoke-rules",
  auditList: "nova:audit:list",
  gitStatus: "nova:git:status",
  gitDiff: "nova:git:diff",
  mcpList: "nova:mcp:list",
  mcpAdd: "nova:mcp:add",
  mcpUpdate: "nova:mcp:update",
  mcpRemove: "nova:mcp:remove",
  mcpTest: "nova:mcp:test",
  mcpTools: "nova:mcp:tools",
  mcpSetToolPermission: "nova:mcp:set-tool-permission",
  mcpLogs: "nova:mcp:logs",
  mcpImportProject: "nova:mcp:import-project",
  webGetPolicy: "nova:web:get-policy",
  webSetPolicy: "nova:web:set-policy",
  companionState: "nova:companion:state",
  companionAct: "nova:companion:act",
  companionWatch: "nova:companion:watch",
  companionSetQuiet: "nova:companion:set-quiet",
  companionNotices: "nova:companion:notices",
  /** main -> renderer push channel (CompanionEvent). */
  companionEvent: "nova:companion:event",
  checkpointsList: "nova:checkpoints:list",
  checkpointsRestoreFile: "nova:checkpoints:restore-file",
  checkpointsRestoreAll: "nova:checkpoints:restore-all",
  checkpointsCreate: "nova:checkpoints:create",
  checkpointsProposeMerge: "nova:checkpoints:propose-merge",
  checkpointsApplyMerge: "nova:checkpoints:apply-merge",

  // J2-B "parité Harness"
  processesList: "nova:processes:list",
  processesOutput: "nova:processes:output",
  processesStop: "nova:processes:stop",
  /** main -> renderer push channel (ProcessEvent). */
  processesEvent: "nova:processes:event",
  contextUsage: "nova:context:usage",
  contextCompact: "nova:context:compact",
  contextDecide: "nova:context:decide",
  contextList: "nova:context:list",
  contextHandoff: "nova:context:handoff",
  /** main -> renderer push channel (ContextEvent). */
  contextEvent: "nova:context:event",
  skillsList: "nova:skills:list",
  skillsGet: "nova:skills:get",
  skillsPreview: "nova:skills:preview",
  skillsInstall: "nova:skills:install",
  skillsUninstall: "nova:skills:uninstall",
  skillsSetEnabled: "nova:skills:set-enabled",
  submissionsTree: "nova:submissions:tree",
  submissionsIntegrate: "nova:submissions:integrate",
  submissionsDiscard: "nova:submissions:discard",
  schedulesList: "nova:schedules:list",
  schedulesCreate: "nova:schedules:create",
  schedulesUpdate: "nova:schedules:update",
  schedulesSetPaused: "nova:schedules:set-paused",
  schedulesRemove: "nova:schedules:remove",
  schedulesRuns: "nova:schedules:runs",
  /** main -> renderer push channel (ScheduleEvent). */
  schedulesEvent: "nova:schedules:event",
  desktopState: "nova:desktop:state",
  /** main -> renderer push channel (DesktopEvent). */
  desktopEvent: "nova:desktop:event",
  autopilotClassify: "nova:autopilot:classify",
  timelineSearch: "nova:timeline:search",
  timelineFork: "nova:timeline:fork",
  /**
   * main -> preload only: carries a transferred MessagePort (`webContents.postMessage`) with a
   * `NovaPortEnvelope` payload. The preload re-posts it to the page (see ./ports).
   */
  portTransfer: "nova:port:transfer",
} as const;

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];

/** Channels main pushes on; every other channel is an invoke route handled in main. */
export const PUSH_CHANNELS: readonly IpcChannel[] = [
  IPC_CHANNELS.chatEvent,
  IPC_CHANNELS.filesEvent,
  IPC_CHANNELS.missionsEvent,
  IPC_CHANNELS.approvalsEvent,
  IPC_CHANNELS.terminalEvent,
  IPC_CHANNELS.companionEvent,
  IPC_CHANNELS.processesEvent,
  IPC_CHANNELS.contextEvent,
  IPC_CHANNELS.schedulesEvent,
  IPC_CHANNELS.desktopEvent,
  IPC_CHANNELS.portTransfer,
];

/** `type` of the window message the preload posts (with the port in `ports[0]`). */
export const NOVA_PORT_MESSAGE = "nova:port";

/** Streams carried by MessagePorts. `id` is the session/stream id the port belongs to. */
export type NovaPortKind = "terminal";

export interface NovaPortEnvelope {
  kind: NovaPortKind;
  id: string;
}
