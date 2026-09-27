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
  missionsPlan: "nova:missions:plan",
  missionsStart: "nova:missions:start",
  missionsPause: "nova:missions:pause",
  missionsResume: "nova:missions:resume",
  missionsStop: "nova:missions:stop",
  missionsList: "nova:missions:list",
  missionsGet: "nova:missions:get",
  missionsReview: "nova:missions:review",
  /** main -> renderer push channel (MissionEvent). */
  missionsEvent: "nova:missions:event",
  approvalsList: "nova:approvals:list",
  approvalsDecide: "nova:approvals:decide",
  permissionsGetProfile: "nova:permissions:get-profile",
  permissionsSetProfile: "nova:permissions:set-profile",
  gitStatus: "nova:git:status",
  gitDiff: "nova:git:diff",
  mcpList: "nova:mcp:list",
  mcpAdd: "nova:mcp:add",
  mcpUpdate: "nova:mcp:update",
  mcpRemove: "nova:mcp:remove",
  mcpTest: "nova:mcp:test",
  mcpTools: "nova:mcp:tools",
  mcpSetToolPermission: "nova:mcp:set-tool-permission",
  webGetPolicy: "nova:web:get-policy",
  webSetPolicy: "nova:web:set-policy",
  companionState: "nova:companion:state",
  companionAct: "nova:companion:act",
  /** main -> renderer push channel (CompanionEvent). */
  companionEvent: "nova:companion:event",
  checkpointsList: "nova:checkpoints:list",
  checkpointsRestoreFile: "nova:checkpoints:restore-file",
  checkpointsRestoreAll: "nova:checkpoints:restore-all",
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
  IPC_CHANNELS.companionEvent,
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
