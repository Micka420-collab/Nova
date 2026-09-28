// Typed IPC contract between the renderer (untrusted UI) and the Electron main process.
// Every request payload is validated with these schemas in main before use.
import { z } from "zod";
import type {
  AppInfo,
  AppSettings,
  Conversation,
  ConversationDetail,
  ConversationPage,
  Message,
  ModelCatalog,
  ProviderConnectionView,
  ProviderErrorInfo,
  UsageSummary,
} from "./domain";

import type {
  CompanionActRequest,
  CompanionActResult,
  CompanionEvent,
  CompanionNotice,
  CompanionQuietRequest,
  CompanionState,
  CompanionStateRequest,
  CompanionWatchRequest,
  CompanionWatchResult,
} from "./companion";
import type { GitDiff, GitDiffRequest, GitStatus } from "./git";
import { EntityIdSchema, ModelIdSchema } from "./ids";
import type {
  McpImportDraft,
  McpImportProjectRequest,
  McpListRequest,
  McpServerIdRequest,
  McpServerInput,
  McpServerUpdateRequest,
  McpServerView,
  McpSetToolPermissionRequest,
  McpTestResult,
  McpToolInfo,
  McpToolsRequest,
} from "./mcp";
import type {
  Mission,
  MissionDetail,
  MissionDiff,
  MissionEvent,
  MissionGetRequest,
  MissionIdRequest,
  MissionPage,
  MissionPlanRequest,
  MissionPlanResult,
  MissionResumeRequest,
  MissionStartRequest,
  MissionsListRequest,
  ReviewDecideRequest,
  ReviewResult,
} from "./missions";
import type {
  Approval,
  ApprovalDecideRequest,
  ApprovalEvent,
  ApprovalsListRequest,
  AuditEntry,
  AuditListRequest,
  PermissionProfileState,
  PermissionRevokeRequest,
  PermissionRule,
  PermissionRulesRequest,
  PermissionsProfileRequest,
  PermissionsSetProfileRequest,
} from "./permissions";
import type {
  TerminalCreateRequest,
  TerminalEvent,
  TerminalListRequest,
  TerminalResizeRequest,
  TerminalSession,
  TerminalSessionRequest,
} from "./terminal";
import type { WebPolicy, WebPolicyGetRequest, WebPolicySetRequest } from "./web";
import {
  RelativeEntryPathSchema,
  RelativePathSchema,
} from "./paths";
import type {
  Checkpoint,
  CheckpointApplyMergeRequest,
  CheckpointCreateRequest,
  CheckpointMergeRequest,
  CheckpointRestoreAllRequest,
  CheckpointRestoreFileRequest,
  CheckpointsListRequest,
  EditorSessionSnapshot,
  EditorStateSetRequest,
  FileContent,
  FileEntry,
  FileSearchQuery,
  FileSearchResult,
  FileWriteRequest,
  FileWriteResult,
  FilesCreateRequest,
  FilesEvent,
  FilesListRequest,
  FilesMoveRequest,
  FilesReadRequest,
  FilesTrashRequest,
  MergeProposal,
  RestoreAllResult,
  RestoreFileResult,
  SearchQuery,
  SearchResult,
  Workspace,
  WorkspaceConsentRequest,
  WorkspaceFacts,
  WorkspaceFactsRequest,
  WorkspaceIdRequest,
  WorkspaceRecentRequest,
} from "./workspace";

export { IPC_CHANNELS, type IpcChannel } from "./channels";

// ---------------------------------------------------------------------------
// Request schemas

const providerId = z.literal("openrouter");
const entityId = EntityIdSchema;
const modelId = ModelIdSchema;

export const ProviderRequestSchema = z.object({ providerId });

export const SetKeyRequestSchema = z.object({
  providerId,
  apiKey: z
    .string()
    .trim()
    .min(8)
    .max(512)
    // Printable ASCII only: invisible or typographic characters (zero-width space, "…", smart
    // quotes) cannot travel in an HTTP header and would otherwise look like a network failure.
    .regex(/^[\x21-\x7E]+$/, "la clé contient un caractère invalide"),
  storage: z.enum(["vault", "weak-vault", "session"]),
});

export const CatalogRequestSchema = z.object({ providerId, refresh: z.boolean() });

export const ListConversationsRequestSchema = z.object({
  query: z.string().max(200).optional(),
});

export const ConversationIdRequestSchema = z.object({ conversationId: entityId });

export const RenameConversationRequestSchema = z.object({
  conversationId: entityId,
  title: z.string().trim().min(1).max(120),
});

/** C6: what a message or a mission goal points at. Files are read in main (C8 exclusions, secret scan). */
export const ContextMentionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("file"), path: RelativeEntryPathSchema }),
  z.object({ kind: z.literal("folder"), path: RelativePathSchema }),
  z.object({ kind: z.literal("url"), url: z.url({ protocol: /^https?$/ }).max(2_000) }),
]);
export type ContextMention = z.infer<typeof ContextMentionSchema>;

export const ChatSendRequestSchema = z.object({
  conversationId: entityId.nullable(),
  content: z.string().trim().min(1).max(100_000),
  modelId,
  /** Workspace the mentions are resolved in (null/absent: no workspace, mentions refused). */
  workspaceId: entityId.nullable().optional(),
  /** C6 mentions attached to this message only (sent once, never stored with the message). */
  attachments: z.array(ContextMentionSchema).max(20).optional(),
  /** W1: the "Web" button of Discuter; never automatic. Domain policy of the workspace applies. */
  webSearch: z.boolean().optional(),
});

export const ChatStopRequestSchema = z.object({ streamId: entityId });

export const ChatRetryRequestSchema = z.object({
  conversationId: entityId,
  assistantMessageId: entityId,
  modelId,
});

export const OpenExternalRequestSchema = z.object({ url: z.url({ protocol: /^https$/ }) });

export const SettingsPatchSchema = z
  .object({
    theme: z.enum(["system", "dark", "light"]),
    defaultModelId: modelId.nullable(),
    companion: z
      .object({ visible: z.boolean(), motion: z.enum(["system", "reduce", "full"]) })
      .partial()
      .strict(),
    privacy: z.object({ providerDataCollection: z.enum(["deny", "allow"]) }).partial().strict(),
  })
  .partial()
  .strict();

export type ProviderRequest = z.infer<typeof ProviderRequestSchema>;
export type SetKeyRequest = z.infer<typeof SetKeyRequestSchema>;
export type CatalogRequest = z.infer<typeof CatalogRequestSchema>;
export type ListConversationsRequest = z.infer<typeof ListConversationsRequestSchema>;
export type ConversationIdRequest = z.infer<typeof ConversationIdRequestSchema>;
export type RenameConversationRequest = z.infer<typeof RenameConversationRequestSchema>;
export type ChatSendRequest = z.infer<typeof ChatSendRequestSchema>;
export type ChatStopRequest = z.infer<typeof ChatStopRequestSchema>;
export type ChatRetryRequest = z.infer<typeof ChatRetryRequestSchema>;
export type OpenExternalRequest = z.infer<typeof OpenExternalRequestSchema>;
export type SettingsPatch = z.infer<typeof SettingsPatchSchema>;

// ---------------------------------------------------------------------------
// Results

export interface ChatSendResult {
  conversation: Conversation;
  userMessage: Message;
  assistantMessage: Message;
  streamId: string;
}

export interface ChatRetryResult {
  assistantMessage: Message;
  streamId: string;
}

export interface ActiveStream {
  streamId: string;
  conversationId: string;
  messageId: string;
  modelId: string;
  phase: StreamPhase;
}

/**
 * Real progress of a generation, used by the UI and the companion.
 * - `waiting`: request sent, nothing received yet.
 * - `reasoning`: the model emits reasoning tokens (content is not kept nor shown).
 * - `writing`: answer text is arriving.
 */
export type StreamPhase = "waiting" | "reasoning" | "writing";

export type ChatStreamEvent =
  | {
      type: "phase";
      streamId: string;
      conversationId: string;
      messageId: string;
      phase: StreamPhase;
    }
  | { type: "delta"; streamId: string; conversationId: string; messageId: string; text: string }
  | {
      type: "meta";
      streamId: string;
      conversationId: string;
      messageId: string;
      servedModel: string | null;
      servedProvider: string | null;
    }
  | {
      type: "usage";
      streamId: string;
      conversationId: string;
      messageId: string;
      usage: UsageSummary;
    }
  | { type: "completed"; streamId: string; conversationId: string; message: Message }
  | { type: "stopped"; streamId: string; conversationId: string; message: Message }
  | {
      type: "failed";
      streamId: string;
      conversationId: string;
      message: Message;
      error: ProviderErrorInfo;
    };

// ---------------------------------------------------------------------------
// Result envelope: main never throws raw errors across IPC.

export type IpcErrorCode =
  | "invalid_request"
  | "not_found"
  | "conflict"
  | "vault_unavailable"
  | "no_key"
  /** A stored key exists but cannot be decrypted (keyring locked, changed or reset). */
  | "key_unreadable"
  | "provider"
  /** The capability exists in the contract but is not available now (worker down, not built yet). */
  | "unavailable"
  | "internal";

export interface IpcError {
  code: IpcErrorCode;
  /** Short developer-facing message (French UI copy is chosen by the renderer from `code`). */
  message: string;
  providerError?: ProviderErrorInfo;
}

export type IpcResult<T> = { ok: true; value: T } | { ok: false; error: IpcError };

/** Error thrown by the preload bridge when main returns `{ ok: false }`. */
export class NovaIpcError extends Error {
  readonly code: IpcErrorCode;
  readonly providerError: ProviderErrorInfo | undefined;
  constructor(error: IpcError) {
    super(error.message);
    this.name = "NovaIpcError";
    this.code = error.code;
    this.providerError = error.providerError;
  }
}

// ---------------------------------------------------------------------------
// API used by the renderer (built by `createNovaClient` over the `window.novaBridge` envelopes).

export interface NovaApi {
  app: {
    info(): Promise<AppInfo>;
    openExternal(req: OpenExternalRequest): Promise<void>;
  };
  settings: {
    get(): Promise<AppSettings>;
    update(patch: SettingsPatch): Promise<AppSettings>;
  };
  connection: {
    get(req: ProviderRequest): Promise<ProviderConnectionView>;
    setKey(req: SetKeyRequest): Promise<ProviderConnectionView>;
    test(req: ProviderRequest): Promise<ProviderConnectionView>;
    remove(req: ProviderRequest): Promise<ProviderConnectionView>;
  };
  models: {
    catalog(req: CatalogRequest): Promise<ModelCatalog>;
  };
  conversations: {
    list(req: ListConversationsRequest): Promise<ConversationPage>;
    get(req: ConversationIdRequest): Promise<ConversationDetail>;
    rename(req: RenameConversationRequest): Promise<Conversation>;
    delete(req: ConversationIdRequest): Promise<void>;
  };
  chat: {
    send(req: ChatSendRequest): Promise<ChatSendResult>;
    stop(req: ChatStopRequest): Promise<void>;
    retry(req: ChatRetryRequest): Promise<ChatRetryResult>;
    active(): Promise<ActiveStream[]>;
    /** Subscribe to streaming events; returns an unsubscribe function. */
    onEvent(listener: (event: ChatStreamEvent) => void): () => void;
  };

  // J2-A. Push subscriptions are always named `onEvent` (MainApi omits them).
  workspace: {
    /** Native folder picker in main; null when the user cancels. */
    open(): Promise<Workspace | null>;
    recent(req: WorkspaceRecentRequest): Promise<Workspace[]>;
    facts(req: WorkspaceFactsRequest): Promise<WorkspaceFacts>;
    close(req: WorkspaceIdRequest): Promise<void>;
    /** D10: answer to "read AGENTS.md / CLAUDE.md / .cursorrules of this project?". */
    setInstructionConsent(req: WorkspaceConsentRequest): Promise<Workspace>;
    /** Reopens a recent workspace by id (no picker). */
    reopen(req: WorkspaceIdRequest): Promise<Workspace>;
    /** Pr3: the editor layout saved for this workspace (paths only); null when none. */
    getEditorState(req: WorkspaceIdRequest): Promise<EditorSessionSnapshot | null>;
    setEditorState(req: EditorStateSetRequest): Promise<void>;
  };
  files: {
    /** One directory level (lazy tree), directories first then files, by name. */
    list(req: FilesListRequest): Promise<FileEntry[]>;
    read(req: FilesReadRequest): Promise<FileContent>;
    write(req: FileWriteRequest): Promise<FileWriteResult>;
    create(req: FilesCreateRequest): Promise<FileEntry>;
    move(req: FilesMoveRequest): Promise<FileEntry>;
    trash(req: FilesTrashRequest): Promise<void>;
    onEvent(listener: (event: FilesEvent) => void): () => void;
  };
  search: {
    text(req: SearchQuery): Promise<SearchResult>;
    files(req: FileSearchQuery): Promise<FileSearchResult>;
  };
  terminal: {
    /** Creates a user terminal; its data port arrives through the port registry (kind `terminal`, id = session id). */
    create(req: TerminalCreateRequest): Promise<TerminalSession>;
    list(req: TerminalListRequest): Promise<TerminalSession[]>;
    /** Sends a fresh data port for an existing session (after a window reload); replays scrollback. */
    attach(req: TerminalSessionRequest): Promise<TerminalSession>;
    resize(req: TerminalResizeRequest): Promise<void>;
    kill(req: TerminalSessionRequest): Promise<void>;
    /** "Prendre la main": an agent session becomes the user's (input accepted from then on). */
    takeOver(req: TerminalSessionRequest): Promise<TerminalSession>;
    onEvent(listener: (event: TerminalEvent) => void): () => void;
  };
  missions: {
    plan(req: MissionPlanRequest): Promise<MissionPlanResult>;
    start(req: MissionStartRequest): Promise<Mission>;
    pause(req: MissionIdRequest): Promise<Mission>;
    resume(req: MissionResumeRequest): Promise<Mission>;
    /** Idempotent; kills running processes; ends in `cancelled` with one terminal event. */
    stop(req: MissionIdRequest): Promise<Mission>;
    list(req: MissionsListRequest): Promise<MissionPage>;
    get(req: MissionGetRequest): Promise<MissionDetail>;
    review(req: ReviewDecideRequest): Promise<ReviewResult>;
    /** A11: the mission's own diff (before its first write → disk now), hunks as `review` indexes them. */
    diff(req: MissionIdRequest): Promise<MissionDiff>;
    onEvent(listener: (event: MissionEvent) => void): () => void;
  };
  approvals: {
    list(req: ApprovalsListRequest): Promise<Approval[]>;
    decide(req: ApprovalDecideRequest): Promise<Approval>;
    onEvent(listener: (event: ApprovalEvent) => void): () => void;
  };
  permissions: {
    getProfile(req: PermissionsProfileRequest): Promise<PermissionProfileState>;
    setProfile(req: PermissionsSetProfileRequest): Promise<PermissionProfileState>;
    /** Rules remembered for this project ("pour ce projet / cette mission"), newest first. */
    listRules(req: PermissionRulesRequest): Promise<PermissionRule[]>;
    /** Revokes one remembered rule, or all of the user's (`ruleId` null). Returns the count. */
    revokeRules(req: PermissionRevokeRequest): Promise<number>;
  };
  audit: {
    /** S5: the audit log, newest first (filters combine). */
    list(req: AuditListRequest): Promise<AuditEntry[]>;
  };
  git: {
    status(req: WorkspaceIdRequest): Promise<GitStatus>;
    diff(req: GitDiffRequest): Promise<GitDiff>;
  };
  mcp: {
    list(req: McpListRequest): Promise<McpServerView[]>;
    add(req: McpServerInput): Promise<McpServerView>;
    update(req: McpServerUpdateRequest): Promise<McpServerView>;
    remove(req: McpServerIdRequest): Promise<void>;
    test(req: McpServerIdRequest): Promise<McpTestResult>;
    tools(req: McpToolsRequest): Promise<McpToolInfo[]>;
    setToolPermission(req: McpSetToolPermissionRequest): Promise<McpToolInfo>;
    /** Redacted stderr tail of a stdio server (live, or from its last run). */
    logs(req: McpServerIdRequest): Promise<string>;
    /** M3: drafts from the workspace's `.mcp.json` (nothing saved; review, then `add`). */
    importProject(req: McpImportProjectRequest): Promise<McpImportDraft[]>;
  };
  web: {
    getPolicy(req: WebPolicyGetRequest): Promise<WebPolicy>;
    setPolicy(req: WebPolicySetRequest): Promise<WebPolicy>;
  };
  companion: {
    state(req: CompanionStateRequest): Promise<CompanionState>;
    act(req: CompanionActRequest): Promise<CompanionActResult>;
    /** P5: Nomi reports this terminal session's next exit. */
    watch(req: CompanionWatchRequest): Promise<CompanionWatchResult>;
    /** P13 quiet mode: system notifications are held until `until`. */
    setQuiet(req: CompanionQuietRequest): Promise<void>;
    /** Notices of this session, newest first (the ones held in quiet mode included). */
    notices(): Promise<CompanionNotice[]>;
    onEvent(listener: (event: CompanionEvent) => void): () => void;
  };
  checkpoints: {
    list(req: CheckpointsListRequest): Promise<Checkpoint[]>;
    restoreFile(req: CheckpointRestoreFileRequest): Promise<RestoreFileResult>;
    restoreAll(req: CheckpointRestoreAllRequest): Promise<RestoreAllResult>;
    /** A user restore point (project replace) that `files.write` can fill with `checkpointId`. */
    create(req: CheckpointCreateRequest): Promise<Checkpoint>;
    /** After a restore `conflict`: undo the agent's change on top of the user's version. */
    proposeMerge(req: CheckpointMergeRequest): Promise<MergeProposal>;
    applyMerge(req: CheckpointApplyMergeRequest): Promise<RestoreFileResult>;
  };
}

// ---------------------------------------------------------------------------
// Bridge shape: what the preload actually exposes. Custom Error subclasses do not survive
// contextBridge, so the preload returns envelopes and the renderer unwraps them.

type BridgeMethod<F> = F extends (...args: infer A) => Promise<infer R>
  ? (...args: A) => Promise<IpcResult<R>>
  : F;

export type NovaBridge = {
  [G in keyof NovaApi]: { [M in keyof NovaApi[G]]: BridgeMethod<NovaApi[G][M]> };
};

async function unwrap<T>(result: Promise<IpcResult<T>>): Promise<T> {
  const settled = await result;
  if (settled.ok) return settled.value;
  throw new NovaIpcError(settled.error);
}

/** Renderer-side client: turns bridge envelopes back into values or `NovaIpcError`. */
export function createNovaClient(bridge: NovaBridge): NovaApi {
  return {
    app: {
      info: () => unwrap(bridge.app.info()),
      openExternal: (req) => unwrap(bridge.app.openExternal(req)),
    },
    settings: {
      get: () => unwrap(bridge.settings.get()),
      update: (patch) => unwrap(bridge.settings.update(patch)),
    },
    connection: {
      get: (req) => unwrap(bridge.connection.get(req)),
      setKey: (req) => unwrap(bridge.connection.setKey(req)),
      test: (req) => unwrap(bridge.connection.test(req)),
      remove: (req) => unwrap(bridge.connection.remove(req)),
    },
    models: {
      catalog: (req) => unwrap(bridge.models.catalog(req)),
    },
    conversations: {
      list: (req) => unwrap(bridge.conversations.list(req)),
      get: (req) => unwrap(bridge.conversations.get(req)),
      rename: (req) => unwrap(bridge.conversations.rename(req)),
      delete: (req) => unwrap(bridge.conversations.delete(req)),
    },
    chat: {
      send: (req) => unwrap(bridge.chat.send(req)),
      stop: (req) => unwrap(bridge.chat.stop(req)),
      retry: (req) => unwrap(bridge.chat.retry(req)),
      active: () => unwrap(bridge.chat.active()),
      onEvent: (listener) => bridge.chat.onEvent(listener),
    },
    workspace: {
      open: () => unwrap(bridge.workspace.open()),
      recent: (req) => unwrap(bridge.workspace.recent(req)),
      facts: (req) => unwrap(bridge.workspace.facts(req)),
      close: (req) => unwrap(bridge.workspace.close(req)),
      setInstructionConsent: (req) => unwrap(bridge.workspace.setInstructionConsent(req)),
      reopen: (req) => unwrap(bridge.workspace.reopen(req)),
      getEditorState: (req) => unwrap(bridge.workspace.getEditorState(req)),
      setEditorState: (req) => unwrap(bridge.workspace.setEditorState(req)),
    },
    files: {
      list: (req) => unwrap(bridge.files.list(req)),
      read: (req) => unwrap(bridge.files.read(req)),
      write: (req) => unwrap(bridge.files.write(req)),
      create: (req) => unwrap(bridge.files.create(req)),
      move: (req) => unwrap(bridge.files.move(req)),
      trash: (req) => unwrap(bridge.files.trash(req)),
      onEvent: (listener) => bridge.files.onEvent(listener),
    },
    search: {
      text: (req) => unwrap(bridge.search.text(req)),
      files: (req) => unwrap(bridge.search.files(req)),
    },
    terminal: {
      create: (req) => unwrap(bridge.terminal.create(req)),
      list: (req) => unwrap(bridge.terminal.list(req)),
      attach: (req) => unwrap(bridge.terminal.attach(req)),
      resize: (req) => unwrap(bridge.terminal.resize(req)),
      kill: (req) => unwrap(bridge.terminal.kill(req)),
      takeOver: (req) => unwrap(bridge.terminal.takeOver(req)),
      onEvent: (listener) => bridge.terminal.onEvent(listener),
    },
    missions: {
      plan: (req) => unwrap(bridge.missions.plan(req)),
      start: (req) => unwrap(bridge.missions.start(req)),
      pause: (req) => unwrap(bridge.missions.pause(req)),
      resume: (req) => unwrap(bridge.missions.resume(req)),
      stop: (req) => unwrap(bridge.missions.stop(req)),
      list: (req) => unwrap(bridge.missions.list(req)),
      get: (req) => unwrap(bridge.missions.get(req)),
      review: (req) => unwrap(bridge.missions.review(req)),
      diff: (req) => unwrap(bridge.missions.diff(req)),
      onEvent: (listener) => bridge.missions.onEvent(listener),
    },
    approvals: {
      list: (req) => unwrap(bridge.approvals.list(req)),
      decide: (req) => unwrap(bridge.approvals.decide(req)),
      onEvent: (listener) => bridge.approvals.onEvent(listener),
    },
    permissions: {
      getProfile: (req) => unwrap(bridge.permissions.getProfile(req)),
      setProfile: (req) => unwrap(bridge.permissions.setProfile(req)),
      listRules: (req) => unwrap(bridge.permissions.listRules(req)),
      revokeRules: (req) => unwrap(bridge.permissions.revokeRules(req)),
    },
    audit: {
      list: (req) => unwrap(bridge.audit.list(req)),
    },
    git: {
      status: (req) => unwrap(bridge.git.status(req)),
      diff: (req) => unwrap(bridge.git.diff(req)),
    },
    mcp: {
      list: (req) => unwrap(bridge.mcp.list(req)),
      add: (req) => unwrap(bridge.mcp.add(req)),
      update: (req) => unwrap(bridge.mcp.update(req)),
      remove: (req) => unwrap(bridge.mcp.remove(req)),
      test: (req) => unwrap(bridge.mcp.test(req)),
      tools: (req) => unwrap(bridge.mcp.tools(req)),
      setToolPermission: (req) => unwrap(bridge.mcp.setToolPermission(req)),
      logs: (req) => unwrap(bridge.mcp.logs(req)),
      importProject: (req) => unwrap(bridge.mcp.importProject(req)),
    },
    web: {
      getPolicy: (req) => unwrap(bridge.web.getPolicy(req)),
      setPolicy: (req) => unwrap(bridge.web.setPolicy(req)),
    },
    companion: {
      state: (req) => unwrap(bridge.companion.state(req)),
      act: (req) => unwrap(bridge.companion.act(req)),
      watch: (req) => unwrap(bridge.companion.watch(req)),
      setQuiet: (req) => unwrap(bridge.companion.setQuiet(req)),
      notices: () => unwrap(bridge.companion.notices()),
      onEvent: (listener) => bridge.companion.onEvent(listener),
    },
    checkpoints: {
      list: (req) => unwrap(bridge.checkpoints.list(req)),
      restoreFile: (req) => unwrap(bridge.checkpoints.restoreFile(req)),
      restoreAll: (req) => unwrap(bridge.checkpoints.restoreAll(req)),
      create: (req) => unwrap(bridge.checkpoints.create(req)),
      proposeMerge: (req) => unwrap(bridge.checkpoints.proposeMerge(req)),
      applyMerge: (req) => unwrap(bridge.checkpoints.applyMerge(req)),
    },
  };
}
