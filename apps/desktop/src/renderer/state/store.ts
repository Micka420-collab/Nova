// Renderer state (zustand): data mirrored from main through the typed client, plus UI state.
import { createStore, type StoreApi } from "zustand/vanilla";
import type {
  AppInfo,
  AppSettings,
  Approval,
  ApprovalScope,
  ChatStreamEvent,
  CompanionAction,
  ConversationDetail,
  GitStatus,
  Mission,
  MissionContractInput,
  MissionEvent,
  MissionPlanResult,
  MissionTaskDraft,
  ModelCatalog,
  NovaApi,
  ProviderConnectionView,
  ProviderErrorInfo,
  ReviewDecision,
  ReviewResult,
  SetKeyRequest,
  SettingsPatch,
  WorkMode,
  Workspace,
  WorkspaceFacts,
} from "@nova/shared";
import { NovaIpcError } from "@nova/shared";
import {
  applyMissionEvent,
  applyMissionEvents,
  viewFromDetail,
  viewFromPlan,
  withApproval,
  type MissionView,
} from "../components/missions/timeline";
import { extractMentions } from "../components/agent/mentions";
import { toUiError, type UiError } from "../lib/errors";
import {
  applyActiveStreams,
  applyChatEvent,
  applyLoadedDetail,
  applyRetryResult,
  applySendResult,
  type ChatSlice,
  type StreamView,
} from "./chat-reducer";
import type { LastOutcome } from "./nomi";

export type Route = "home" | "chat" | "settings";
export type SettingsSection =
  | "providers"
  | "models"
  | "budget"
  | "permissions"
  | "internet"
  | "audit"
  | "privacy"
  | "appearance"
  | "companion"
  | "shortcuts"
  | "diagnostics";

/**
 * Shell disposition (VISUAL.md §3): `converse` puts the thread in the center and the workbench on
 * the right; `build` puts the workbench (editor, diff, mission card) in the center and the agent
 * panel on the right.
 */
export type ShellLayout = "converse" | "build";
/** Créer (guided, comfortable) or Expert (diff, terminal, ids; compact) — UX.md §6. */
export type DisplayMode = "create" | "expert";
/** What the explorer column shows, chosen from the rail. */
export type ExplorerView = "conversations" | "files" | "search" | "missions";

/**
 * Documents of the workbench, shown as tabs. `editor` is the editor group of the editor lane (its
 * own file tabs live inside it); the others are owned by this shell.
 */
export type WorkbenchDoc =
  | { kind: "context" }
  | { kind: "editor" }
  | { kind: "mission"; missionId: string }
  | { kind: "diff"; missionId: string }
  | { kind: "checkpoints"; missionId: string | null }
  | { kind: "extensions" };

export function docKey(doc: WorkbenchDoc): string {
  switch (doc.kind) {
    case "mission":
    case "diff":
      return `${doc.kind}:${doc.missionId}`;
    case "checkpoints":
      return `checkpoints:${doc.missionId ?? "all"}`;
    default:
      return doc.kind;
  }
}

export type DockTab = "terminal";

/**
 * A request to show a file (citation chip, diff "open", Nomi). The editor lane consumes it and
 * acknowledges with `consumeReveal(nonce)`; `nonce` makes repeated requests for the same place distinct.
 */
export interface RevealRequest {
  path: string;
  line: number | null;
  nonce: number;
}

/** A request to show a terminal session in the dock (the terminal lane consumes it). */
export interface TerminalRequest {
  sessionId: string | null;
  nonce: number;
}
export type Loadable = "idle" | "loading" | "ready" | "error";
/** Model choice for the conversation shown in the chat view, the next new conversation, or the default. */
export type ModelTarget = "conversation" | "new" | "default";

/** Key of `modelChoice` for a conversation that does not exist yet. */
export const NEW_CONVERSATION = "new";

export interface UiState {
  route: Route;
  settingsSection: SettingsSection;
  paletteOpen: boolean;
  /** Context panel of the wide layout. */
  rightPanelOpen: boolean;
  /** Narrow layout only: navigation drawer and context overlay. */
  navOpen: boolean;
  contextOverlayOpen: boolean;
  modelPicker: { open: boolean; target: ModelTarget };
  layout: ShellLayout;
  displayMode: DisplayMode;
  explorer: ExplorerView;
  explorerOpen: boolean;
  /** Agent panel (build layout) / workbench column (converse layout). */
  agentOpen: boolean;
  workbenchOpen: boolean;
  dockOpen: boolean;
  dockTab: DockTab;
  docs: WorkbenchDoc[];
  /** Key (`docKey`) of the document shown in the workbench. */
  activeDoc: string;
  reveal: RevealRequest | null;
  terminalRequest: TerminalRequest | null;
  /** Quick open (Ctrl/Cmd+P) of the editor lane. */
  quickOpen: boolean;
  /** Ask the agent panel to move focus to this approval card (explicit user navigation only). */
  approvalFocus: { approvalId: string; nonce: number } | null;
}

export interface WorkspaceState {
  current: Workspace | null;
  facts: WorkspaceFacts | null;
  status: Loadable;
  error: UiError | null;
  /** null = not read yet; `{ available: false }` = no git here. */
  git: GitStatus | null;
}

/** Plan being prepared from the agent composer, before the contract sheet launches it. */
export type PlanState =
  | { status: "idle" }
  | { status: "planning"; goal: string; mode: WorkMode }
  | { status: "ready"; goal: string; mode: WorkMode; result: MissionPlanResult }
  | { status: "starting"; goal: string; mode: WorkMode; result: MissionPlanResult }
  | { status: "error"; goal: string; mode: WorkMode; error: UiError; result: MissionPlanResult | null };

export interface MissionsState {
  list: Mission[];
  listStatus: Loadable;
  listError: UiError | null;
  /** Timelines of the missions seen in this session (loaded or followed live), by id. */
  views: Record<string, MissionView>;
  /** Mission shown by the agent panel; null = the goal composer / chat. */
  selectedId: string | null;
  detailStatus: Loadable;
  detailError: UiError | null;
  plan: PlanState;
  /** Estimates of the plans launched in this session (the end card compares them with the observed cost). */
  estimates: Record<string, MissionPlanResult["estimate"]>;
  /** « Web » toggle of the goal composer (W1): overrides the plan's contract; null = keep main's default. */
  webPreference: boolean | null;
}
/** Unsent composer text of a conversation, with the error of its last failed send (one lifetime). */
export interface Draft {
  text: string;
  error: UiError | null;
}

export interface AppData extends ChatSlice {
  boot: { status: "loading" | "ready" | "error"; error: UiError | null };
  appInfo: AppInfo | null;
  settings: AppSettings | null;
  connection: ProviderConnectionView | null;
  catalog: { status: Loadable; data: ModelCatalog | null; error: UiError | null };
  conversationsStatus: Loadable;
  conversationsError: UiError | null;
  /** The list (or search) was capped by main: older conversations exist beyond it. */
  conversationsHasMore: boolean;
  query: string;
  /** Conversation shown by the chat view; null = a new, not yet created conversation. */
  activeId: string | null;
  detailStatus: Loadable;
  detailError: UiError | null;
  lastOutcome: (LastOutcome & { conversationId: string; error: ProviderErrorInfo | null }) | null;
  /** Model picked but not used yet, by conversation id (or NEW_CONVERSATION). Applied on send. */
  modelChoice: Record<string, string>;
  /** Composer drafts by conversation id (or NEW_CONVERSATION). */
  drafts: Record<string, Draft>;
  /**
   * Conversations whose last answer is known (from this session's events or a loaded detail) to
   * have failed. Conversations never observed are absent: unknown is not shown as failed.
   */
  failed: Record<string, true>;
  ui: UiState;
  workspace: WorkspaceState;
  missions: MissionsState;
  /** Approvals known to this renderer (pending ones first come from events or `approvals.list`). */
  approvals: Record<string, Approval>;
  /** Mode chosen in the agent composer (A12); `discuss` = plain conversation. */
  workMode: WorkMode;
}

export interface AppActions {
  /** Subscribes to chat events and loads everything; returns the unsubscribe function. */
  start(): () => void;
  loadCore(): Promise<void>;
  refreshConversations(): Promise<void>;
  setQuery(query: string): void;
  openConversation(id: string): void;
  newConversation(): void;
  goHome(): void;
  openSettings(section?: SettingsSection): void;
  send(content: string, conversationId: string | null): Promise<void>;
  setDraft(conversationId: string | null, text: string): void;
  /** Sends `content` as the draft of `conversationId`: on failure the draft keeps its text and gets the error. */
  sendDraft(content: string, conversationId: string | null): Promise<boolean>;
  stop(conversationId: string): Promise<void>;
  retry(conversationId: string, messageId: string): Promise<void>;
  rename(id: string, title: string): Promise<void>;
  remove(id: string): Promise<void>;
  chooseModel(modelId: string, target: ModelTarget): Promise<void>;
  setKey(req: Omit<SetKeyRequest, "providerId">): Promise<ProviderConnectionView>;
  testKey(): Promise<ProviderConnectionView>;
  removeKey(): Promise<void>;
  updateSettings(patch: SettingsPatch): Promise<void>;
  loadCatalog(refresh: boolean): Promise<void>;
  setUi(patch: Partial<UiState>): void;
  openModelPicker(target: ModelTarget): void;

  // Shell
  toggleLayout(): void;
  toggleDisplayMode(): void;
  showExplorer(view: ExplorerView): void;
  openDoc(doc: WorkbenchDoc): void;
  closeDoc(key: string): void;
  revealFile(path: string, line: number | null): void;
  consumeReveal(nonce: number): void;
  revealTerminal(sessionId: string | null): void;
  /** Applies a Nomi navigation (`CompanionActResult.navigate`) to the shell. */
  navigateCompanion(action: CompanionAction): void;
  /** Shows the approval card (its mission in the agent panel) and moves focus to it. */
  focusApproval(approvalId: string): void;

  // Workspace (the editor/files lane builds on `workspace.current`)
  openWorkspace(): Promise<void>;
  /** Reopens a recent folder by id (no picker). */
  reopenWorkspace(workspaceId: string): Promise<void>;
  closeWorkspace(): Promise<void>;
  refreshGit(): Promise<void>;

  // Missions, approvals, review
  setWorkMode(mode: WorkMode): void;
  refreshMissions(): Promise<void>;
  planMission(goal: string): Promise<void>;
  discardPlan(): void;
  setWebPreference(value: boolean | null): void;
  startMission(missionId: string, tasks: MissionTaskDraft[] | null, contract: MissionContractInput): Promise<void>;
  selectMission(id: string | null): void;
  pauseMission(id: string): Promise<void>;
  /** `budgetUsd` raises the mission's cap first (a mission suspended by its budget). */
  resumeMission(id: string, budgetUsd?: number): Promise<void>;
  stopMission(id: string): Promise<void>;
  refreshApprovals(): Promise<void>;
  decideApproval(id: string, decision: "approve" | "deny", scope: ApprovalScope): Promise<void>;
  reviewMission(missionId: string, decisions: ReviewDecision[]): Promise<ReviewResult>;
}

export type AppState = AppData & AppActions;
export type AppStore = StoreApi<AppState>;

const PROVIDER = { providerId: "openrouter" } as const;
/** Chat failures that main records on the provider connection (key refused, credits exhausted). */
const CONNECTION_FAILURES = new Set(["invalid_key", "insufficient_credits"]);
const LIST_REFRESH_DELAY_MS = 300;
const GIT_REFRESH_DELAY_MS = 500;

export function initialData(): AppData {
  return {
    boot: { status: "loading", error: null },
    appInfo: null,
    settings: null,
    connection: null,
    catalog: { status: "idle", data: null, error: null },
    conversations: [],
    conversationsStatus: "idle",
    conversationsError: null,
    conversationsHasMore: false,
    query: "",
    streams: {},
    detail: null,
    activeId: null,
    detailStatus: "idle",
    detailError: null,
    lastOutcome: null,
    modelChoice: {},
    drafts: {},
    failed: {},
    ui: {
      route: "home",
      settingsSection: "providers",
      paletteOpen: false,
      rightPanelOpen: true,
      navOpen: false,
      contextOverlayOpen: false,
      modelPicker: { open: false, target: "new" },
      layout: "converse",
      displayMode: "create",
      explorer: "conversations",
      explorerOpen: true,
      agentOpen: true,
      workbenchOpen: true,
      dockOpen: false,
      dockTab: "terminal",
      docs: [{ kind: "context" }],
      activeDoc: "context",
      reveal: null,
      terminalRequest: null,
      approvalFocus: null,
      quickOpen: false,
    },
    workspace: { current: null, facts: null, status: "idle", error: null, git: null },
    missions: {
      list: [],
      listStatus: "idle",
      listError: null,
      views: {},
      selectedId: null,
      detailStatus: "idle",
      detailError: null,
      plan: { status: "idle" },
      estimates: {},
      webPreference: null,
    },
    approvals: {},
    workMode: "discuss",
  };
}

/** Pending approvals, oldest first (the approval shortcut goes to the oldest). */
export function pendingApprovalList(state: Pick<AppData, "approvals">): Approval[] {
  return Object.values(state.approvals)
    .filter((approval) => approval.status === "pending")
    .toSorted((a, b) => a.createdAt - b.createdAt);
}

export function selectedMissionView(state: AppData): MissionView | null {
  const id = state.missions.selectedId;
  return id ? (state.missions.views[id] ?? null) : null;
}

/** A mission of this session that is still running, waiting or suspended (newest first). */
export function liveMission(state: AppData): MissionView | null {
  const views = Object.values(state.missions.views).filter(
    (view) => view.mission.state === "running" || view.mission.state === "waiting_approval",
  );
  return views.toSorted((a, b) => b.mission.updatedAt - a.mission.updatedAt)[0] ?? null;
}

/** Model used for the next message of `conversationId` (null = new conversation). */
export function selectedModelId(state: AppData, conversationId: string | null): string | null {
  const choice = state.modelChoice[conversationId ?? NEW_CONVERSATION];
  if (choice) return choice;
  if (conversationId !== null) {
    const conversation =
      state.detail?.conversation.id === conversationId
        ? state.detail.conversation
        : state.conversations.find((item) => item.id === conversationId);
    if (conversation?.modelId) return conversation.modelId;
  }
  return state.settings?.defaultModelId ?? null;
}

export function activeStream(state: AppData): StreamView | null {
  return state.activeId ? (state.streams[state.activeId] ?? null) : null;
}

/** The phase shown by the companion: the displayed conversation first, then any other stream. */
export function companionPhase(state: AppData): StreamView["phase"] | null {
  return activeStream(state)?.phase ?? Object.values(state.streams)[0]?.phase ?? null;
}

function withFailed(failed: Record<string, true>, conversationId: string, value: boolean): Record<string, true> {
  if (Boolean(failed[conversationId]) === value) return failed;
  const next = { ...failed };
  if (value) next[conversationId] = true;
  else delete next[conversationId];
  return next;
}

function lastAnswerFailed(detail: ConversationDetail): boolean {
  const last = detail.messages.findLast((message) => message.role === "assistant");
  return last?.status === "error";
}

export function createAppStore(client: NovaApi): AppStore {
  let listTimer: ReturnType<typeof setTimeout> | null = null;
  let detailRequest = 0;

  return createStore<AppState>()((set, get) => {
    const chatSlice = (): ChatSlice => {
      const { streams, detail, conversations } = get();
      return { streams, detail, conversations };
    };

    const scheduleListRefresh = () => {
      if (listTimer) clearTimeout(listTimer);
      listTimer = setTimeout(() => {
        listTimer = null;
        void get().refreshConversations();
      }, LIST_REFRESH_DELAY_MS);
    };

    /** Usage totals are computed by the store in main; only they are refreshed, messages stay live. */
    const refreshUsage = async (conversationId: string) => {
      try {
        const fresh = await client.conversations.get({ conversationId });
        const { detail } = get();
        if (detail?.conversation.id === conversationId) set({ detail: { ...detail, usage: fresh.usage } });
      } catch {
        // The totals keep their previous value; the next load of the conversation recomputes them.
      }
    };

    /** Main records key and credit failures on the connection; the renderer reads that recorded state. */
    const refreshConnection = async () => {
      try {
        set({ connection: await client.connection.get(PROVIDER) });
      } catch {
        // The previous state stays; the failed answer already shows its own error.
      }
    };

    /**
     * After a failed or stopped run, main's copy is the truth: a retry that ends before any text is
     * deleted and the previous answer restored, while the event still carries the deleted message.
     * The shown messages and the failed marker are rebuilt from main.
     */
    const reloadAfterRun = async (conversationId: string, failedRun: boolean) => {
      try {
        const fresh = await client.conversations.get({ conversationId });
        set({ failed: withFailed(get().failed, conversationId, lastAnswerFailed(fresh)) });
        if (get().detail?.conversation.id === conversationId) set(applyLoadedDetail(chatSlice(), fresh));
      } catch {
        // Unreadable now (e.g. deleted): keep what the event said; the next load of the conversation fixes it.
        set({ failed: withFailed(get().failed, conversationId, failedRun) });
      }
    };

    const onEvent = (event: ChatStreamEvent) => {
      set(applyChatEvent(chatSlice(), event));
      if (event.type === "phase" || event.type === "delta") {
        // A new run in this conversation: its previous failure is no longer the last answer.
        set({ failed: withFailed(get().failed, event.conversationId, false) });
        return;
      }
      if (event.type !== "completed" && event.type !== "stopped" && event.type !== "failed") return;
      const kind = event.type === "completed" ? "success" : event.type === "failed" ? "error" : "stopped";
      const error = event.type === "failed" ? event.error : null;
      set({ lastOutcome: { kind, at: Date.now(), conversationId: event.conversationId, error } });
      if (error && CONNECTION_FAILURES.has(error.code)) void refreshConnection();
      if (kind === "success") {
        set({ failed: withFailed(get().failed, event.conversationId, false) });
        if (get().detail?.conversation.id === event.conversationId) void refreshUsage(event.conversationId);
      } else {
        void reloadAfterRun(event.conversationId, kind === "error");
      }
      scheduleListRefresh();
    };

    const patchDraft = (key: string, patch: Partial<Draft>) => {
      set((state) => {
        const current = state.drafts[key] ?? { text: "", error: null };
        return { drafts: { ...state.drafts, [key]: { ...current, ...patch } } };
      });
    };

    const dropDraft = (key: string) => {
      set((state) => {
        if (!(key in state.drafts)) return {};
        const drafts = { ...state.drafts };
        delete drafts[key];
        return { drafts };
      });
    };

    const loadDetail = async (id: string) => {
      const request = ++detailRequest;
      set({ detailStatus: "loading", detailError: null });
      try {
        const detail = await client.conversations.get({ conversationId: id });
        if (request !== detailRequest || get().activeId !== id) return;
        set({
          ...applyLoadedDetail(chatSlice(), detail),
          detailStatus: "ready",
          failed: withFailed(get().failed, id, lastAnswerFailed(detail)),
        });
      } catch (error) {
        if (request !== detailRequest) return;
        set({ detailStatus: "error", detailError: toUiError(error), detail: null });
      }
    };


    // ---------------------------------------------------------------------------
    // Atelier: missions, approvals, workspace

    let gitTimer: ReturnType<typeof setTimeout> | null = null;
    let missionsTimer: ReturnType<typeof setTimeout> | null = null;
    let nonce = 0;
    const nextNonce = () => ++nonce;

    const scheduleGitRefresh = () => {
      if (gitTimer) clearTimeout(gitTimer);
      gitTimer = setTimeout(() => {
        gitTimer = null;
        void get().refreshGit();
      }, GIT_REFRESH_DELAY_MS);
    };

    const scheduleMissionsRefresh = () => {
      if (missionsTimer) clearTimeout(missionsTimer);
      missionsTimer = setTimeout(() => {
        missionsTimer = null;
        void get().refreshMissions();
      }, LIST_REFRESH_DELAY_MS);
    };

    const patchMissions = (patch: Partial<MissionsState>) => set((state) => ({ missions: { ...state.missions, ...patch } }));

    /** Records a mission (from a result or an event) in the view and the list. */
    const putMission = (mission: Mission) =>
      set((state) => {
        const view = state.missions.views[mission.id];
        const views = view ? { ...state.missions.views, [mission.id]: { ...view, mission } } : state.missions.views;
        const exists = state.missions.list.some((item) => item.id === mission.id);
        const list = exists
          ? state.missions.list.map((item) => (item.id === mission.id ? mission : item))
          : [mission, ...state.missions.list];
        return { missions: { ...state.missions, views, list } };
      });

    const putView = (view: MissionView) =>
      set((state) => ({ missions: { ...state.missions, views: { ...state.missions.views, [view.mission.id]: view } } }));

    const onMissionEvent = (event: MissionEvent) => {
      const current = get().missions.views[event.missionId];
      const next = applyMissionEvent(current, event);
      const approval = event.type === "approval.requested" || event.type === "approval.resolved" ? event.approval : null;
      if (next && next !== current) {
        putView(next);
        const known = get().missions.list.some((item) => item.id === next.mission.id);
        if (known || event.type === "mission.created") putMission(next.mission);
      }
      if (approval) set((state) => ({ approvals: { ...state.approvals, [approval.id]: approval } }));
      if (!current && event.type !== "mission.created" && get().missions.selectedId === event.missionId) {
        // An event of the shown mission before its detail arrived: the load includes it.
        void loadMission(event.missionId);
      }
      const touchedFiles = event.type === "tool.finished" && event.display.kind === "file_change";
      const ended = event.type === "mission.succeeded" || event.type === "mission.failed" || event.type === "mission.cancelled";
      if (touchedFiles || ended || event.type === "review.decided") scheduleGitRefresh();
      if (ended || event.type === "mission.created") scheduleMissionsRefresh();
    };

    let missionRequest = 0;
    const loadMission = async (id: string) => {
      const request = ++missionRequest;
      const known = get().missions.views[id];
      patchMissions({ detailStatus: known ? "ready" : "loading", detailError: null });
      try {
        const detail = await client.missions.get({ missionId: id, afterSeq: 0 });
        const current = get().missions.views[id];
        // Live events may have arrived meanwhile: merge instead of replacing.
        putView(current ? applyMissionEvents({ ...current, budget: detail.budget ?? current.budget }, detail.events) : viewFromDetail(detail));
        if (request === missionRequest) patchMissions({ detailStatus: "ready" });
      } catch (error) {
        if (request === missionRequest) patchMissions({ detailStatus: known ? "ready" : "error", detailError: toUiError(error) });
      }
    };

    /** Opens (picker) or reopens (recent) a folder: the atelier then follows it. */
    const activateWorkspace = async (open: () => Promise<Workspace | null>): Promise<void> => {
      set((state) => ({ workspace: { ...state.workspace, status: "loading", error: null } }));
      let opened: Workspace | null;
      try {
        opened = await open();
      } catch (error) {
        set((state) => ({
          workspace: { ...state.workspace, status: state.workspace.current ? "ready" : "error", error: toUiError(error) },
        }));
        throw error;
      }
      if (!opened) {
        // The user cancelled the picker: nothing changes.
        set((state) => ({ workspace: { ...state.workspace, status: state.workspace.current ? "ready" : "idle" } }));
        return;
      }
      const workspace = opened;
      set((state) => ({
        ...resetAtelier(),
        workspace: { current: workspace, facts: null, status: "ready", error: null, git: null },
        ui: {
          ...state.ui,
          explorer: "files",
          explorerOpen: true,
          layout: state.ui.displayMode === "expert" ? "build" : state.ui.layout,
          docs: state.ui.docs.some((doc) => doc.kind === "editor") ? state.ui.docs : [...state.ui.docs, { kind: "editor" }],
        },
      }));
      client.workspace
        .facts({ workspaceId: workspace.id, refresh: false })
        .then((facts) => {
          if (get().workspace.current?.id === workspace.id) set((state) => ({ workspace: { ...state.workspace, facts } }));
        })
        // Facts are optional context (stack banner, test command); unknown stays unknown.
        .catch(() => undefined);
      void get().refreshGit();
      void get().refreshMissions();
      void get().refreshApprovals();
    };

    const resetAtelier = (): Partial<AppData> => {
      const initial = initialData();
      return { workspace: initial.workspace, missions: initial.missions, approvals: {} };
    };

    return {
      ...initialData(),

      start() {
        const unsubscribe = client.chat.onEvent(onEvent);
        const unsubscribeMissions = client.missions.onEvent(onMissionEvent);
        // Every approval, a mission's or not: the card and the pending count follow main.
        const unsubscribeApprovals = client.approvals.onEvent(({ approval }) =>
          set((state) => ({ approvals: { ...state.approvals, [approval.id]: approval } })),
        );
        void get().loadCore();
        void get().refreshConversations();
        void get().loadCatalog(false);
        // After subscribing: a stream found here and its events cannot be missed in between.
        client.chat
          .active()
          .then((active) => set(applyActiveStreams(chatSlice(), active)))
          // Not fatal: a running stream missing here shows up with its next event.
          .catch(() => undefined);
        return () => {
          unsubscribe();
          unsubscribeMissions();
          unsubscribeApprovals();
          if (listTimer) clearTimeout(listTimer);
          if (gitTimer) clearTimeout(gitTimer);
          if (missionsTimer) clearTimeout(missionsTimer);
        };
      },

      async loadCore() {
        set({ boot: { status: "loading", error: null } });
        try {
          const [appInfo, settings, connection] = await Promise.all([
            client.app.info(),
            client.settings.get(),
            client.connection.get(PROVIDER),
          ]);
          set({ appInfo, settings, connection, boot: { status: "ready", error: null } });
        } catch (error) {
          set({ boot: { status: "error", error: toUiError(error) } });
        }
      },

      async refreshConversations() {
        const query = get().query.trim();
        if (get().conversationsStatus !== "ready") set({ conversationsStatus: "loading" });
        try {
          const page = await client.conversations.list(query ? { query } : {});
          if (get().query.trim() !== query) return;
          set({
            conversations: page.items,
            conversationsHasMore: page.hasMore,
            conversationsStatus: "ready",
            conversationsError: null,
          });
        } catch (error) {
          set({ conversationsStatus: "error", conversationsError: toUiError(error) });
        }
      },

      setQuery(query) {
        set({ query });
        void get().refreshConversations();
      },

      openConversation(id) {
        set((state) => ({
          activeId: id,
          detail: state.detail?.conversation.id === id ? state.detail : null,
          ui: { ...state.ui, route: "chat", navOpen: false, contextOverlayOpen: false },
        }));
        void loadDetail(id);
      },

      newConversation() {
        detailRequest += 1;
        set((state) => ({
          activeId: null,
          detail: null,
          detailStatus: "idle",
          detailError: null,
          ui: { ...state.ui, route: "chat", navOpen: false, contextOverlayOpen: false },
        }));
      },

      goHome() {
        set((state) => ({ ui: { ...state.ui, route: "home", navOpen: false, contextOverlayOpen: false } }));
      },

      openSettings(section) {
        set((state) => ({
          ui: {
            ...state.ui,
            route: "settings",
            settingsSection: section ?? state.ui.settingsSection,
            navOpen: false,
            contextOverlayOpen: false,
          },
        }));
      },

      async send(content, conversationId) {
        const modelId = selectedModelId(get(), conversationId);
        if (!modelId) throw new Error("send() called without a selected model");
        // C6/W1: with a folder open, the @mentions of the message and the Web button go with it.
        const workspaceId = get().workspace.current?.id ?? null;
        const attachments = workspaceId ? extractMentions(content) : [];
        const webSearch = get().missions.webPreference === true;
        const result = await client.chat.send({
          conversationId,
          content,
          modelId,
          ...(workspaceId ? { workspaceId } : {}),
          ...(attachments.length > 0 ? { attachments } : {}),
          ...(webSearch ? { webSearch } : {}),
        });
        // Stream events are emitted only after this result (runtime contract), so none were lost.
        const state = get();
        const createdHere = conversationId === null;
        const stillThere = createdHere
          ? state.ui.route === "home" || (state.ui.route === "chat" && state.activeId === null)
          : state.activeId === conversationId;
        const next = applySendResult(chatSlice(), result, stillThere);
        const modelChoice = { ...state.modelChoice };
        delete modelChoice[conversationId ?? NEW_CONVERSATION];
        const failed = withFailed(state.failed, result.conversation.id, false);
        if (!(createdHere && stillThere)) {
          set({ ...next, modelChoice, failed });
          return;
        }
        // The new conversation becomes the shown one, in the same update as its messages.
        detailRequest += 1;
        set({
          ...next,
          modelChoice,
          failed,
          activeId: result.conversation.id,
          detailStatus: "ready",
          detailError: null,
          ui: { ...state.ui, route: "chat" },
        });
      },

      setDraft(conversationId, text) {
        const key = conversationId ?? NEW_CONVERSATION;
        if (text === "" && !get().drafts[key]?.error) dropDraft(key);
        else patchDraft(key, { text });
      },

      async sendDraft(content, conversationId) {
        const key = conversationId ?? NEW_CONVERSATION;
        patchDraft(key, { error: null });
        try {
          await get().send(content, conversationId);
          dropDraft(key);
          return true;
        } catch (error) {
          patchDraft(key, { error: toUiError(error) });
          return false;
        }
      },

      async stop(conversationId) {
        const stream = get().streams[conversationId];
        if (!stream) return;
        try {
          await client.chat.stop({ streamId: stream.streamId });
        } catch (error) {
          // The stream ended before the stop arrived: its terminal event reports the real outcome.
          if (error instanceof NovaIpcError && error.code === "not_found") return;
          throw error;
        }
      },

      async retry(conversationId, messageId) {
        const modelId = selectedModelId(get(), conversationId);
        if (!modelId) throw new Error("retry() called without a selected model");
        const result = await client.chat.retry({ conversationId, assistantMessageId: messageId, modelId });
        const modelChoice = { ...get().modelChoice };
        delete modelChoice[conversationId];
        set({
          ...applyRetryResult(chatSlice(), conversationId, messageId, result),
          modelChoice,
          failed: withFailed(get().failed, conversationId, false),
        });
      },

      async rename(id, title) {
        const conversation = await client.conversations.rename({ conversationId: id, title });
        set((state) => ({
          conversations: state.conversations.map((item) => (item.id === id ? { ...item, ...conversation } : item)),
          detail: state.detail?.conversation.id === id ? { ...state.detail, conversation } : state.detail,
        }));
      },

      async remove(id) {
        await client.conversations.delete({ conversationId: id });
        set((state) => {
          const streams = { ...state.streams };
          delete streams[id];
          const isActive = state.activeId === id;
          const drafts = { ...state.drafts };
          delete drafts[id];
          return {
            conversations: state.conversations.filter((item) => item.id !== id),
            streams,
            drafts,
            failed: withFailed(state.failed, id, false),
            ...(isActive
              ? { activeId: null, detail: null, detailStatus: "idle" as const, ui: { ...state.ui, route: "home" as const } }
              : {}),
          };
        });
      },

      async chooseModel(modelId, target) {
        const state = get();
        if (target === "conversation" || target === "new") {
          const key = target === "conversation" && state.activeId ? state.activeId : NEW_CONVERSATION;
          set({ modelChoice: { ...state.modelChoice, [key]: modelId } });
        }
        if (target === "default" || !state.settings?.defaultModelId) {
          set({ settings: await client.settings.update({ defaultModelId: modelId }) });
        }
      },

      async setKey(req) {
        const connection = await client.connection.setKey({ ...PROVIDER, ...req });
        set({ connection });
        return connection;
      },

      async testKey() {
        const connection = await client.connection.test(PROVIDER);
        set({ connection });
        return connection;
      },

      async removeKey() {
        set({ connection: await client.connection.remove(PROVIDER) });
      },

      async updateSettings(patch) {
        set({ settings: await client.settings.update(patch) });
      },

      async loadCatalog(refresh) {
        set((state) => ({ catalog: { ...state.catalog, status: "loading", error: null } }));
        try {
          const data = await client.models.catalog({ ...PROVIDER, refresh });
          set({ catalog: { status: "ready", data, error: null } });
        } catch (error) {
          set((state) => ({ catalog: { status: "error", data: state.catalog.data, error: toUiError(error) } }));
        }
      },

      setUi(patch) {
        set((state) => ({ ui: { ...state.ui, ...patch } }));
      },

      openModelPicker(target) {
        set((state) => ({ ui: { ...state.ui, paletteOpen: false, modelPicker: { open: true, target } } }));
      },

      toggleLayout() {
        set((state) => ({ ui: { ...state.ui, layout: state.ui.layout === "converse" ? "build" : "converse" } }));
      },

      toggleDisplayMode() {
        set((state) => ({ ui: { ...state.ui, displayMode: state.ui.displayMode === "create" ? "expert" : "create" } }));
      },

      showExplorer(view) {
        set((state) => ({ ui: { ...state.ui, explorer: view, explorerOpen: true } }));
      },

      openDoc(doc) {
        const key = docKey(doc);
        set((state) => {
          const docs = state.ui.docs.some((item) => docKey(item) === key) ? state.ui.docs : [...state.ui.docs, doc];
          return {
            ui: {
              ...state.ui,
              docs,
              activeDoc: key,
              workbenchOpen: true,
            },
          };
        });
      },

      closeDoc(key) {
        set((state) => {
          const index = state.ui.docs.findIndex((item) => docKey(item) === key);
          if (index === -1) return {};
          const docs = state.ui.docs.filter((_, i) => i !== index);
          const neighbor = docs[index] ?? docs[index - 1];
          const activeDoc = state.ui.activeDoc === key ? (neighbor ? docKey(neighbor) : "context") : state.ui.activeDoc;
          return { ui: { ...state.ui, docs: docs.length > 0 ? docs : [{ kind: "context" }], activeDoc } };
        });
      },

      revealFile(path, line) {
        get().openDoc({ kind: "editor" });
        // VISUAL.md §3: opening a file puts the workbench in the center (build), also in Créer.
        set((state) => ({
          ui: {
            ...state.ui,
            ...(state.workspace.current ? { layout: "build" as const, route: "chat" as const } : {}),
            reveal: { path, line, nonce: nextNonce() },
          },
        }));
      },

      consumeReveal(requestNonce) {
        set((state) => (state.ui.reveal?.nonce === requestNonce ? { ui: { ...state.ui, reveal: null } } : {}));
      },

      revealTerminal(sessionId) {
        set((state) => ({
          ui: { ...state.ui, dockOpen: true, dockTab: "terminal", terminalRequest: { sessionId, nonce: nextNonce() } },
        }));
      },

      focusApproval(approvalId) {
        const approval = get().approvals[approvalId];
        const missionId = approval?.request.missionId ?? null;
        if (missionId) get().selectMission(missionId);
        set((state) => ({
          ui: { ...state.ui, route: "chat", agentOpen: true, approvalFocus: { approvalId, nonce: nextNonce() } },
        }));
      },

      navigateCompanion(action) {
        switch (action.type) {
          case "open_approval":
            get().focusApproval(action.approvalId);
            return;
          case "show_changes":
            get().openDoc({ kind: "diff", missionId: action.missionId });
            return;
          case "open_diff":
            get().openDoc({ kind: "diff", missionId: action.missionId });
            return;
          case "start_mission":
          case "stop_mission":
            // Performed by main; its events update the timeline.
            return;
          case "explain_error":
          case "watch_command":
            if (action.sourceRef.kind === "terminal") get().revealTerminal(action.sourceRef.sessionId);
            else if (action.sourceRef.kind === "tool_call" || action.sourceRef.kind === "mission") {
              get().selectMission(action.sourceRef.missionId);
              set((state) => ({ ui: { ...state.ui, route: "chat", agentOpen: true } }));
            }
            return;
        }
      },

      async openWorkspace() {
        await activateWorkspace(() => client.workspace.open());
      },

      async reopenWorkspace(workspaceId) {
        await activateWorkspace(() => client.workspace.reopen({ workspaceId }));
      },

      async closeWorkspace() {
        const current = get().workspace.current;
        if (!current) return;
        await client.workspace.close({ workspaceId: current.id });
        set((state) => ({
          ...resetAtelier(),
          ui: {
            ...state.ui,
            explorer: "conversations",
            layout: "converse",
            docs: state.ui.docs.filter((doc) => doc.kind === "context" || doc.kind === "extensions"),
            activeDoc: "context",
            dockOpen: false,
          },
        }));
      },

      async refreshGit() {
        const current = get().workspace.current;
        if (!current) return;
        try {
          const git = await client.git.status({ workspaceId: current.id });
          if (get().workspace.current?.id === current.id) set((state) => ({ workspace: { ...state.workspace, git } }));
        } catch {
          // Unknown stays unknown: the status bar shows no branch rather than a guess.
        }
      },

      setWorkMode(mode) {
        set({ workMode: mode });
      },

      async refreshMissions() {
        const workspaceId = get().workspace.current?.id ?? null;
        if (get().missions.listStatus !== "ready") patchMissions({ listStatus: "loading" });
        try {
          const page = await client.missions.list({ workspaceId, limit: 50 });
          if ((get().workspace.current?.id ?? null) !== workspaceId) return;
          patchMissions({ list: page.items, listStatus: "ready", listError: null });
        } catch (error) {
          patchMissions({ listStatus: "error", listError: toUiError(error) });
        }
      },

      async planMission(goal) {
        const state = get();
        const workspace = state.workspace.current;
        const modelId = selectedModelId(state, state.activeId);
        if (!workspace || !modelId) throw new Error("planMission() called without a workspace or a model");
        const mode = state.workMode;
        patchMissions({ plan: { status: "planning", goal, mode } });
        try {
          const result = await client.missions.plan({
            workspaceId: workspace.id,
            conversationId: state.activeId,
            goal,
            mode,
            modelId,
            contract: null,
          });
          const current = get().missions.views[result.mission.id];
          putView(current ? { ...current, tasks: current.tasks.length > 0 ? current.tasks : result.tasks } : viewFromPlan(result));
          putMission(result.mission);
          patchMissions({ plan: { status: "ready", goal, mode, result } });
        } catch (error) {
          patchMissions({ plan: { status: "error", goal, mode, error: toUiError(error), result: null } });
        }
      },

      discardPlan() {
        patchMissions({ plan: { status: "idle" } });
      },

      setWebPreference(value) {
        patchMissions({ webPreference: value });
      },

      async startMission(missionId, tasks, contract) {
        const plan = get().missions.plan;
        const result = plan.status === "ready" || plan.status === "starting" || plan.status === "error" ? plan.result : null;
        if (!result || result.mission.id !== missionId || plan.status === "idle" || plan.status === "planning") {
          throw new Error("startMission() called without the matching plan");
        }
        const { goal, mode } = plan;
        patchMissions({ plan: { status: "starting", goal, mode, result } });
        try {
          const mission = await client.missions.start({ missionId, tasks, contract });
          putMission(mission);
          set((state) => ({
            missions: {
              ...state.missions,
              plan: { status: "idle" },
              selectedId: missionId,
              estimates: { ...state.missions.estimates, [missionId]: result.estimate },
            },
          }));
        } catch (error) {
          patchMissions({ plan: { status: "error", goal, mode, error: toUiError(error), result } });
        }
      },

      selectMission(id) {
        patchMissions({ selectedId: id, detailError: null });
        if (id) void loadMission(id);
      },

      async pauseMission(id) {
        putMission(await client.missions.pause({ missionId: id }));
      },

      async resumeMission(id, budgetUsd) {
        putMission(await client.missions.resume({ missionId: id, ...(budgetUsd === undefined ? {} : { budgetUsd }) }));
      },

      async stopMission(id) {
        putMission(await client.missions.stop({ missionId: id }));
      },

      async refreshApprovals() {
        const workspaceId = get().workspace.current?.id ?? null;
        try {
          const pending = await client.approvals.list({ workspaceId, missionId: null, status: "pending" });
          set((state) => {
            const approvals = { ...state.approvals };
            for (const approval of pending) approvals[approval.id] = approval;
            return { approvals };
          });
        } catch {
          // Pending approvals also arrive as mission events; a failed list only delays them.
        }
      },

      async decideApproval(id, decision, scope) {
        const approval = await client.approvals.decide({ approvalId: id, decision, scope });
        set((state) => {
          const missionId = approval.request.missionId;
          const view = missionId ? state.missions.views[missionId] : undefined;
          return {
            approvals: { ...state.approvals, [approval.id]: approval },
            ...(view && missionId
              ? { missions: { ...state.missions, views: { ...state.missions.views, [missionId]: withApproval(view, approval) } } }
              : {}),
          };
        });
      },

      async reviewMission(missionId, decisions) {
        const result = await client.missions.review({ missionId, decisions });
        scheduleGitRefresh();
        return result;
      },
    };
  });
}
