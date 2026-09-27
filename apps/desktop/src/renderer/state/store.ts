// Renderer state (zustand): data mirrored from main through the typed client, plus UI state.
import { createStore, type StoreApi } from "zustand/vanilla";
import type {
  AppInfo,
  AppSettings,
  ChatStreamEvent,
  ConversationDetail,
  ModelCatalog,
  NovaApi,
  ProviderConnectionView,
  ProviderErrorInfo,
  SetKeyRequest,
  SettingsPatch,
} from "@nova/shared";
import { NovaIpcError } from "@nova/shared";
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
  | "privacy"
  | "appearance"
  | "companion"
  | "shortcuts"
  | "diagnostics";
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
}

export type AppState = AppData & AppActions;
export type AppStore = StoreApi<AppState>;

const PROVIDER = { providerId: "openrouter" } as const;
/** Chat failures that main records on the provider connection (key refused, credits exhausted). */
const CONNECTION_FAILURES = new Set(["invalid_key", "insufficient_credits"]);
const LIST_REFRESH_DELAY_MS = 300;

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
    },
  };
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

    return {
      ...initialData(),

      start() {
        const unsubscribe = client.chat.onEvent(onEvent);
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
          if (listTimer) clearTimeout(listTimer);
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
        const result = await client.chat.send({ conversationId, content, modelId });
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
    };
  });
}
