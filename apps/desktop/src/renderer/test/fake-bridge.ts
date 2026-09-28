// In-memory NovaBridge for renderer tests: same envelopes as the preload, no Electron, no network.
import {
  DEFAULT_SETTINGS,
  type ActiveStream,
  type AppInfo,
  type AppSettings,
  type ChatStreamEvent,
  type Conversation,
  type HarnessGroup,
  type IpcError,
  type IpcResult,
  type Message,
  type ModelCatalog,
  type ModelInfo,
  type NovaBridge,
  type ProviderConnectionView,
} from "@nova/shared";

const unsubscribeNothing = (): (() => void) => () => {};

/**
 * J2-A groups answer `unavailable` unless a test seeds an in-memory fake for the group it
 * exercises (`seed.atelier`): a test never depends on a service it does not set up.
 */
function unavailableAtelierBridge(record: (name: string) => void): Pick<NovaBridge, AtelierGroup> {
  const no = (name: string) => (): Promise<IpcResult<never>> => {
    record(name);
    return Promise.resolve({ ok: false, error: { code: "unavailable", message: `${name} is not available yet` } });
  };
  return {
    workspace: {
      open: no("workspace.open"),
      recent: no("workspace.recent"),
      facts: no("workspace.facts"),
      close: no("workspace.close"),
      setInstructionConsent: no("workspace.setInstructionConsent"),
      reopen: no("workspace.reopen"),
      getEditorState: no("workspace.getEditorState"),
      setEditorState: no("workspace.setEditorState"),
    },
    files: {
      list: no("files.list"),
      read: no("files.read"),
      write: no("files.write"),
      create: no("files.create"),
      move: no("files.move"),
      trash: no("files.trash"),
      onEvent: unsubscribeNothing,
    },
    search: { text: no("search.text"), files: no("search.files") },
    terminal: {
      create: no("terminal.create"),
      list: no("terminal.list"),
      attach: no("terminal.attach"),
      resize: no("terminal.resize"),
      kill: no("terminal.kill"),
      takeOver: no("terminal.takeOver"),
      onEvent: unsubscribeNothing,
    },
    missions: {
      plan: no("missions.plan"),
      start: no("missions.start"),
      pause: no("missions.pause"),
      resume: no("missions.resume"),
      stop: no("missions.stop"),
      list: no("missions.list"),
      get: no("missions.get"),
      review: no("missions.review"),
      diff: no("missions.diff"),
      onEvent: unsubscribeNothing,
    },
    approvals: { list: no("approvals.list"), decide: no("approvals.decide"), onEvent: unsubscribeNothing },
    permissions: {
      getProfile: no("permissions.getProfile"),
      setProfile: no("permissions.setProfile"),
      listRules: no("permissions.listRules"),
      revokeRules: no("permissions.revokeRules"),
    },
    audit: { list: no("audit.list") },
    git: { status: no("git.status"), diff: no("git.diff") },
    mcp: {
      list: no("mcp.list"),
      add: no("mcp.add"),
      update: no("mcp.update"),
      remove: no("mcp.remove"),
      test: no("mcp.test"),
      tools: no("mcp.tools"),
      setToolPermission: no("mcp.setToolPermission"),
      logs: no("mcp.logs"),
      importProject: no("mcp.importProject"),
    },
    web: { getPolicy: no("web.getPolicy"), setPolicy: no("web.setPolicy") },
    companion: {
      state: no("companion.state"),
      act: no("companion.act"),
      watch: no("companion.watch"),
      setQuiet: no("companion.setQuiet"),
      notices: no("companion.notices"),
      onEvent: unsubscribeNothing,
    },
    checkpoints: {
      list: no("checkpoints.list"),
      restoreFile: no("checkpoints.restoreFile"),
      restoreAll: no("checkpoints.restoreAll"),
      create: no("checkpoints.create"),
      proposeMerge: no("checkpoints.proposeMerge"),
      applyMerge: no("checkpoints.applyMerge"),
    },
  };
}

/** J2-B groups answer `unavailable` like main before a lane is wired (seed.harness overrides). */
function unavailableHarnessBridge(record: (name: string) => void): Pick<NovaBridge, HarnessGroup> {
  const no = (name: string) => (): Promise<IpcResult<never>> => {
    record(name);
    return Promise.resolve({ ok: false, error: { code: "unavailable", message: `${name} is not available yet` } });
  };
  return {
    processes: { list: no("processes.list"), output: no("processes.output"), stop: no("processes.stop"), onEvent: unsubscribeNothing },
    context: {
      usage: no("context.usage"),
      compact: no("context.compact"),
      decide: no("context.decide"),
      list: no("context.list"),
      handoff: no("context.handoff"),
      onEvent: unsubscribeNothing,
    },
    skills: {
      list: no("skills.list"),
      get: no("skills.get"),
      preview: no("skills.preview"),
      install: no("skills.install"),
      uninstall: no("skills.uninstall"),
      setEnabled: no("skills.setEnabled"),
    },
    submissions: { tree: no("submissions.tree"), integrate: no("submissions.integrate"), discard: no("submissions.discard") },
    schedules: {
      list: no("schedules.list"),
      create: no("schedules.create"),
      update: no("schedules.update"),
      setPaused: no("schedules.setPaused"),
      remove: no("schedules.remove"),
      runs: no("schedules.runs"),
      onEvent: unsubscribeNothing,
    },
    desktop: { state: no("desktop.state"), onEvent: unsubscribeNothing },
    autopilot: { classify: no("autopilot.classify") },
    timeline: { search: no("timeline.search"), fork: no("timeline.fork") },
  };
}

export type AtelierGroup =
  | "workspace"
  | "files"
  | "search"
  | "terminal"
  | "missions"
  | "approvals"
  | "permissions"
  | "audit"
  | "git"
  | "mcp"
  | "web"
  | "companion"
  | "checkpoints";

let sequence = 0;
/** Deterministic UUID-shaped ids (the IPC schemas require UUIDs). */
export function testId(): string {
  sequence += 1;
  return `00000000-0000-4000-8000-${sequence.toString(16).padStart(12, "0")}`;
}

export function makeConversation(partial: Partial<Conversation> = {}): Conversation {
  return { id: testId(), title: "Conversation", modelId: null, createdAt: 1_000, updatedAt: 1_000, ...partial };
}

export function makeMessage(partial: Partial<Message> & Pick<Message, "conversationId">): Message {
  return {
    id: testId(),
    role: "assistant",
    content: "",
    status: "complete",
    modelId: null,
    servedModel: null,
    servedProvider: null,
    error: null,
    usage: null,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...partial,
  };
}

export function makeModel(partial: Partial<ModelInfo> & Pick<ModelInfo, "id">): ModelInfo {
  return {
    name: partial.id,
    author: partial.id.split("/")[0] ?? "",
    description: null,
    contextLength: null,
    maxCompletionTokens: null,
    inputModalities: ["text"],
    outputModalities: ["text"],
    supportsTools: null,
    supportsStructuredOutputs: null,
    supportsReasoning: null,
    pricing: { promptPerMTok: null, completionPerMTok: null, variable: false },
    isFree: false,
    expirationDate: null,
    createdAt: null,
    ...partial,
  };
}

export const ABSENT_CONNECTION: ProviderConnectionView = {
  providerId: "openrouter",
  state: "absent",
  storage: null,
  keyHint: null,
  lastCheckedAt: null,
  lastError: null,
  check: null,
};

export const VALID_CONNECTION: ProviderConnectionView = {
  providerId: "openrouter",
  state: "valid",
  storage: "vault",
  keyHint: "a1b2",
  lastCheckedAt: 1_000,
  lastError: null,
  check: { label: "NOVA", limit: null, limitRemaining: null, usage: 0.5, isFreeTier: false },
};

export interface FakeSeed {
  connection?: ProviderConnectionView;
  settings?: Partial<AppSettings>;
  conversations?: Array<{ conversation: Conversation; messages: Message[] }>;
  models?: ModelInfo[];
  vaultLevel?: AppInfo["vault"]["level"];
  /** `conversations.list` reports older conversations beyond the returned page. */
  hasMoreConversations?: boolean;
  /** Connection returned by `connection.setKey` (default: verified). */
  setKeyResult?: ProviderConnectionView;
  /**
   * In-memory implementations of J2-A groups (see `test/atelier-fake.ts`); methods left out keep
   * answering `unavailable`, like main before a group is wired.
   */
  atelier?: AtelierOverrides;
  /** In-memory J2-B groups; methods left out answer `unavailable`. */
  harness?: HarnessOverrides;
}

export type HarnessOverrides = { [G in HarnessGroup]?: Partial<NovaBridge[G]> };

export type AtelierOverrides = { [G in AtelierGroup]?: Partial<NovaBridge[G]> };

function withAtelier(
  base: Pick<NovaBridge, AtelierGroup>,
  overrides: AtelierOverrides | undefined,
  record: (name: string) => void,
): Pick<NovaBridge, AtelierGroup> {
  if (!overrides) return base;
  const merged: Record<string, unknown> = { ...base };
  for (const group of Object.keys(overrides) as AtelierGroup[]) {
    const methods = overrides[group] ?? {};
    const wrapped: Record<string, unknown> = {};
    for (const [name, method] of Object.entries(methods)) {
      // Calls are recorded like the J1 groups; `onEvent` subscriptions are not calls.
      wrapped[name] =
        typeof method === "function" && name !== "onEvent"
          ? (...args: unknown[]) => {
              record(`${group}.${name}`);
              return (method as (...a: unknown[]) => unknown)(...args);
            }
          : method;
    }
    merged[group] = { ...base[group], ...wrapped };
  }
  return merged as Pick<NovaBridge, AtelierGroup>;
}

export interface FakeBridge {
  bridge: NovaBridge;
  /** Pushes a stream event to the subscribed renderer, as main does. */
  emit: (event: ChatStreamEvent) => void;
  /** Names of the bridge methods called, in order. */
  calls: string[];
  /** Makes the next call of `name` fail with this IPC error. */
  failNext: (name: string, error: IpcError) => void;
  /** Replaces the connection main would return (e.g. main recorded a refused key). */
  setConnection: (next: ProviderConnectionView) => void;
}

export function createFakeBridge(seed: FakeSeed = {}): FakeBridge {
  const calls: string[] = [];
  const failures = new Map<string, IpcError>();
  const listeners = new Set<(event: ChatStreamEvent) => void>();
  let connection = seed.connection ?? ABSENT_CONNECTION;
  let settings: AppSettings = { ...DEFAULT_SETTINGS, ...seed.settings };
  const conversations = new Map((seed.conversations ?? []).map((entry) => [entry.conversation.id, { ...entry }]));
  const active: ActiveStream[] = [];
  const catalog: ModelCatalog = {
    providerId: "openrouter",
    models: seed.models ?? [],
    fetchedAt: Date.now(),
    source: "network",
    refreshError: null,
  };

  function reply<T>(name: string, produce: () => T): Promise<IpcResult<T>> {
    calls.push(name);
    const failure = failures.get(name);
    if (failure) {
      failures.delete(name);
      return Promise.resolve({ ok: false, error: failure });
    }
    try {
      return Promise.resolve({ ok: true, value: produce() });
    } catch (error) {
      return Promise.resolve({ ok: false, error: { code: "not_found", message: String(error) } });
    }
  }

  function findEntry(id: string) {
    const found = conversations.get(id);
    if (!found) throw new Error("Conversation not found");
    return found;
  }

  const harness: Record<string, unknown> = { ...unavailableHarnessBridge((name) => calls.push(name)) };
  for (const [group, methods] of Object.entries(seed.harness ?? {})) {
    harness[group] = { ...(harness[group] as object), ...methods };
  }
  const bridge: NovaBridge = {
    ...(harness as Pick<NovaBridge, HarnessGroup>),
    ...withAtelier(
      unavailableAtelierBridge((name) => calls.push(name)),
      seed.atelier,
      (name) => calls.push(name),
    ),
    app: {
      info: () =>
        reply("app.info", () => ({
          version: "0.1.0",
          platform: "linux",
          arch: "x64",
          isPackaged: false,
          electronVersion: "44.4.5",
          dataDir: "/tmp/nova",
          logDir: "/tmp/nova/logs",
          vault: { level: seed.vaultLevel ?? "os", backend: "gnome_libsecret" },
        })),
      openExternal: () => reply("app.openExternal", () => undefined),
    },
    settings: {
      get: () => reply("settings.get", () => settings),
      update: (patch) =>
        reply("settings.update", () => {
          settings = {
            ...settings,
            ...patch,
            companion: { ...settings.companion, ...patch.companion },
            privacy: { ...settings.privacy, ...patch.privacy },
            desktop: { ...settings.desktop, ...patch.desktop },
            onboarding: { ...settings.onboarding, ...patch.onboarding },
            display: { ...settings.display, ...patch.display },
            chat: { ...settings.chat, ...patch.chat },
          };
          return settings;
        }),
    },
    connection: {
      get: () => reply("connection.get", () => connection),
      setKey: (req) =>
        reply("connection.setKey", () => {
          connection = seed.setKeyResult ?? { ...VALID_CONNECTION, storage: req.storage, keyHint: req.apiKey.slice(-4) };
          return connection;
        }),
      test: () => reply("connection.test", () => connection),
      remove: () =>
        reply("connection.remove", () => {
          connection = ABSENT_CONNECTION;
          return connection;
        }),
    },
    models: {
      catalog: () => reply("models.catalog", () => catalog),
    },
    conversations: {
      list: (req) =>
        reply("conversations.list", () => {
          const query = req.query?.toLowerCase() ?? "";
          const matches = ({ conversation, messages }: { conversation: Conversation; messages: Message[] }) =>
            conversation.title.toLowerCase().includes(query) ||
            messages.some((message) => message.content.toLowerCase().includes(query));
          const items = [...conversations.values()]
            .filter(matches)
            .map(({ conversation, messages }) => ({
              ...conversation,
              messageCount: messages.length,
              preview: messages.at(-1)?.content ?? null,
            }))
            .sort((a, b) => b.updatedAt - a.updatedAt);
          return { items, hasMore: seed.hasMoreConversations ?? false };
        }),
      get: ({ conversationId }) =>
        reply("conversations.get", () => {
          const { conversation, messages } = findEntry(conversationId);
          return {
            conversation,
            messages,
            usage: { promptTokens: 0, completionTokens: 0, cost: 0, messagesWithUnknownCost: 0 },
          };
        }),
      rename: ({ conversationId, title }) =>
        reply("conversations.rename", () => {
          const found = findEntry(conversationId);
          found.conversation = { ...found.conversation, title };
          return found.conversation;
        }),
      delete: ({ conversationId }) =>
        reply("conversations.delete", () => {
          findEntry(conversationId);
          conversations.delete(conversationId);
        }),
    },
    chat: {
      send: (req) =>
        reply("chat.send", () => {
          const conversation =
            req.conversationId === null
              ? makeConversation({ title: req.content.slice(0, 60), modelId: req.modelId })
              : findEntry(req.conversationId).conversation;
          const found = conversations.get(conversation.id) ?? { conversation, messages: [] };
          conversations.set(conversation.id, found);
          const userMessage = makeMessage({ conversationId: conversation.id, role: "user", content: req.content });
          const assistantMessage = makeMessage({
            conversationId: conversation.id,
            status: "streaming",
            modelId: req.modelId,
          });
          found.messages = [...found.messages, userMessage, assistantMessage];
          const streamId = testId();
          active.push({
            streamId,
            conversationId: conversation.id,
            messageId: assistantMessage.id,
            modelId: req.modelId,
            phase: "waiting",
          });
          return { conversation, userMessage, assistantMessage, streamId };
        }),
      stop: () => reply("chat.stop", () => undefined),
      retry: (req) =>
        reply("chat.retry", () => ({
          assistantMessage: makeMessage({ conversationId: req.conversationId, status: "streaming", modelId: req.modelId }),
          streamId: testId(),
        })),
      active: () => reply("chat.active", () => [...active]),
      onEvent: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
  };

  return {
    bridge,
    emit: (event) => {
      // Main persists a run's final message before reporting it. A message main no longer has (a
      // retry deleted when it ended before any text) stays absent.
      if (event.type === "completed" || event.type === "stopped" || event.type === "failed") {
        const entry = conversations.get(event.conversationId);
        if (entry) {
          entry.messages = entry.messages.map((message) => (message.id === event.message.id ? event.message : message));
        }
        const index = active.findIndex((item) => item.streamId === event.streamId);
        if (index !== -1) active.splice(index, 1);
      }
      for (const listener of listeners) listener(event);
    },
    calls,
    failNext: (name, error) => {
      failures.set(name, error);
    },
    setConnection: (next) => {
      connection = next;
    },
  };
}
