// Sandboxed preload: exposes the fixed NovaBridge API as `window.novaBridge`, nothing else.
// Only channel names are imported at runtime; shared types are erased (no zod in this bundle).
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type {
  ApprovalEvent,
  ChatStreamEvent,
  CompanionEvent,
  ContextEvent,
  DesktopEvent,
  FilesEvent,
  IpcResult,
  MissionEvent,
  NovaBridge,
  NovaPortEnvelope,
  ProcessEvent,
  ScheduleEvent,
  TerminalEvent,
} from "@nova/shared";
import { IPC_CHANNELS, NOVA_PORT_MESSAGE } from "@nova/shared/channels";

const C = IPC_CHANNELS;

/** Resolves with main's envelope; a transport failure (no handler, closing) becomes an internal error. */
async function invoke<T>(channel: string, payload?: unknown): Promise<IpcResult<T>> {
  try {
    return (await ipcRenderer.invoke(channel, payload)) as IpcResult<T>;
  } catch {
    return { ok: false, error: { code: "internal", message: "IPC call failed" } };
  }
}

/** Push subscription. Forwards the payload only: the IpcRendererEvent would expose `sender` (ipcRenderer). */
function subscribe<E>(channel: string, listener: (event: E) => void): () => void {
  const relay = (_event: IpcRendererEvent, payload: E): void => listener(payload);
  ipcRenderer.on(channel, relay);
  return () => {
    ipcRenderer.removeListener(channel, relay);
  };
}

/**
 * MessagePort relay (see packages/shared/src/ports.ts): contextBridge cannot carry ports, so a
 * port transferred by main is re-posted to this window with a validated envelope. Only the fixed
 * envelope shape is forwarded; exactly one port per message.
 */
ipcRenderer.on(C.portTransfer, (event: IpcRendererEvent, envelope: NovaPortEnvelope) => {
  const port = event.ports[0];
  if (event.ports.length !== 1 || !port) return;
  if (typeof envelope?.kind !== "string" || typeof envelope.id !== "string") return;
  window.postMessage({ type: NOVA_PORT_MESSAGE, kind: envelope.kind, id: envelope.id }, "*", [port]);
});

const bridge: NovaBridge = {
  app: {
    info: () => invoke(C.appInfo),
    openExternal: (req) => invoke(C.appOpenExternal, req),
  },
  settings: {
    get: () => invoke(C.settingsGet),
    update: (patch) => invoke(C.settingsUpdate, patch),
  },
  connection: {
    get: (req) => invoke(C.connectionGet, req),
    setKey: (req) => invoke(C.connectionSetKey, req),
    test: (req) => invoke(C.connectionTest, req),
    remove: (req) => invoke(C.connectionRemove, req),
  },
  models: {
    catalog: (req) => invoke(C.modelsCatalog, req),
  },
  conversations: {
    list: (req) => invoke(C.conversationsList, req),
    get: (req) => invoke(C.conversationsGet, req),
    rename: (req) => invoke(C.conversationsRename, req),
    delete: (req) => invoke(C.conversationsDelete, req),
  },
  chat: {
    send: (req) => invoke(C.chatSend, req),
    stop: (req) => invoke(C.chatStop, req),
    retry: (req) => invoke(C.chatRetry, req),
    active: () => invoke(C.chatActive),
    onEvent: (listener) => subscribe<ChatStreamEvent>(C.chatEvent, listener),
  },
  workspace: {
    open: () => invoke(C.workspaceOpen),
    recent: (req) => invoke(C.workspaceRecent, req),
    facts: (req) => invoke(C.workspaceFacts, req),
    close: (req) => invoke(C.workspaceClose, req),
    setInstructionConsent: (req) => invoke(C.workspaceSetInstructionConsent, req),
    reopen: (req) => invoke(C.workspaceReopen, req),
    getEditorState: (req) => invoke(C.workspaceGetEditorState, req),
    setEditorState: (req) => invoke(C.workspaceSetEditorState, req),
  },
  files: {
    list: (req) => invoke(C.filesList, req),
    read: (req) => invoke(C.filesRead, req),
    write: (req) => invoke(C.filesWrite, req),
    create: (req) => invoke(C.filesCreate, req),
    move: (req) => invoke(C.filesMove, req),
    trash: (req) => invoke(C.filesTrash, req),
    onEvent: (listener) => subscribe<FilesEvent>(C.filesEvent, listener),
  },
  search: {
    text: (req) => invoke(C.searchText, req),
    files: (req) => invoke(C.searchFiles, req),
  },
  terminal: {
    create: (req) => invoke(C.terminalCreate, req),
    list: (req) => invoke(C.terminalList, req),
    attach: (req) => invoke(C.terminalAttach, req),
    resize: (req) => invoke(C.terminalResize, req),
    kill: (req) => invoke(C.terminalKill, req),
    takeOver: (req) => invoke(C.terminalTakeOver, req),
    onEvent: (listener) => subscribe<TerminalEvent>(C.terminalEvent, listener),
  },
  missions: {
    plan: (req) => invoke(C.missionsPlan, req),
    start: (req) => invoke(C.missionsStart, req),
    pause: (req) => invoke(C.missionsPause, req),
    resume: (req) => invoke(C.missionsResume, req),
    stop: (req) => invoke(C.missionsStop, req),
    list: (req) => invoke(C.missionsList, req),
    get: (req) => invoke(C.missionsGet, req),
    review: (req) => invoke(C.missionsReview, req),
    diff: (req) => invoke(C.missionsDiff, req),
    onEvent: (listener) => subscribe<MissionEvent>(C.missionsEvent, listener),
  },
  approvals: {
    list: (req) => invoke(C.approvalsList, req),
    decide: (req) => invoke(C.approvalsDecide, req),
    onEvent: (listener) => subscribe<ApprovalEvent>(C.approvalsEvent, listener),
  },
  permissions: {
    getProfile: (req) => invoke(C.permissionsGetProfile, req),
    setProfile: (req) => invoke(C.permissionsSetProfile, req),
    listRules: (req) => invoke(C.permissionsListRules, req),
    revokeRules: (req) => invoke(C.permissionsRevokeRules, req),
  },
  audit: {
    list: (req) => invoke(C.auditList, req),
  },
  git: {
    status: (req) => invoke(C.gitStatus, req),
    diff: (req) => invoke(C.gitDiff, req),
  },
  mcp: {
    list: (req) => invoke(C.mcpList, req),
    add: (req) => invoke(C.mcpAdd, req),
    update: (req) => invoke(C.mcpUpdate, req),
    remove: (req) => invoke(C.mcpRemove, req),
    test: (req) => invoke(C.mcpTest, req),
    tools: (req) => invoke(C.mcpTools, req),
    setToolPermission: (req) => invoke(C.mcpSetToolPermission, req),
    logs: (req) => invoke(C.mcpLogs, req),
    importProject: (req) => invoke(C.mcpImportProject, req),
  },
  web: {
    getPolicy: (req) => invoke(C.webGetPolicy, req),
    setPolicy: (req) => invoke(C.webSetPolicy, req),
  },
  companion: {
    state: (req) => invoke(C.companionState, req),
    act: (req) => invoke(C.companionAct, req),
    watch: (req) => invoke(C.companionWatch, req),
    setQuiet: (req) => invoke(C.companionSetQuiet, req),
    notices: () => invoke(C.companionNotices),
    onEvent: (listener) => subscribe<CompanionEvent>(C.companionEvent, listener),
  },
  checkpoints: {
    list: (req) => invoke(C.checkpointsList, req),
    restoreFile: (req) => invoke(C.checkpointsRestoreFile, req),
    restoreAll: (req) => invoke(C.checkpointsRestoreAll, req),
    create: (req) => invoke(C.checkpointsCreate, req),
    proposeMerge: (req) => invoke(C.checkpointsProposeMerge, req),
    applyMerge: (req) => invoke(C.checkpointsApplyMerge, req),
  },
  processes: {
    list: (req) => invoke(C.processesList, req),
    output: (req) => invoke(C.processesOutput, req),
    stop: (req) => invoke(C.processesStop, req),
    onEvent: (listener) => subscribe<ProcessEvent>(C.processesEvent, listener),
  },
  context: {
    usage: (req) => invoke(C.contextUsage, req),
    compact: (req) => invoke(C.contextCompact, req),
    decide: (req) => invoke(C.contextDecide, req),
    list: (req) => invoke(C.contextList, req),
    handoff: (req) => invoke(C.contextHandoff, req),
    onEvent: (listener) => subscribe<ContextEvent>(C.contextEvent, listener),
  },
  skills: {
    list: (req) => invoke(C.skillsList, req),
    get: (req) => invoke(C.skillsGet, req),
    preview: (req) => invoke(C.skillsPreview, req),
    install: (req) => invoke(C.skillsInstall, req),
    uninstall: (req) => invoke(C.skillsUninstall, req),
    setEnabled: (req) => invoke(C.skillsSetEnabled, req),
  },
  submissions: {
    tree: (req) => invoke(C.submissionsTree, req),
    integrate: (req) => invoke(C.submissionsIntegrate, req),
    discard: (req) => invoke(C.submissionsDiscard, req),
  },
  schedules: {
    list: (req) => invoke(C.schedulesList, req),
    create: (req) => invoke(C.schedulesCreate, req),
    update: (req) => invoke(C.schedulesUpdate, req),
    setPaused: (req) => invoke(C.schedulesSetPaused, req),
    remove: (req) => invoke(C.schedulesRemove, req),
    runs: (req) => invoke(C.schedulesRuns, req),
    onEvent: (listener) => subscribe<ScheduleEvent>(C.schedulesEvent, listener),
  },
  desktop: {
    state: () => invoke(C.desktopState),
    onEvent: (listener) => subscribe<DesktopEvent>(C.desktopEvent, listener),
  },
  autopilot: {
    classify: (req) => invoke(C.autopilotClassify, req),
  },
  timeline: {
    search: (req) => invoke(C.timelineSearch, req),
    fork: (req) => invoke(C.timelineFork, req),
  },
};

contextBridge.exposeInMainWorld("novaBridge", bridge);
