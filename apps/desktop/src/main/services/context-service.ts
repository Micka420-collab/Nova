// `context.*` IPC group (C7/A15, J2-B L2): context usage, compaction proposals and decisions,
// handoff dossier. The logic is `createCompactionCore` (@nova/missions); this module binds it to
// SQLite, the catalog and the provider:
// - a mission summary is one call through the missions provider proxy, so its cost is RESERVED
//   on the mission budget before the call and settled after (refusal = visible `conflict`);
// - a conversation summary is one call with the stored key (chat has no budget; its cost is
//   kept on the summary row and shown on the card);
// - the runtime hook (`runtimeHook`) is the main side of the loop's context hook and
//   `historyForModel` the chat's; both only ever apply what the user applied.
// No Electron import: tested in Node.
import type { RuntimeLogger } from "@nova/agent-runtime";
import {
  CompactionError,
  ProxyError,
  createCompactionCore,
  eventFromRecord,
  type AppliedConversationHistory,
  type CompactionPromptBuilder,
  type LoopContextHook,
  type MissionEventInput,
  type ProviderProxy,
  type SummarizeRequest,
  type SummarizeResult,
} from "@nova/missions";
import { ProviderError, type ModelProvider } from "@nova/providers";
import type { ContextEvent, ContextUsage, Message } from "@nova/shared";
import { createCompactionRepo, createMissionRepo, type NovaStore } from "@nova/storage";
import type { MainApi } from "../api";
import { ServiceError } from "../service-error";

/** The missions side, resolved lazily (the missions service is created with this hook). */
export interface ContextMissionRuntime {
  isRunning(missionId: string): boolean;
  /** `MissionController.journal`. */
  journal: { append(event: MissionEventInput): unknown };
  /** `MissionsService.host.proxy`: key in main, reservation on the mission budget. */
  proxy: ProviderProxy;
}

export interface ContextServiceDeps {
  store: NovaStore;
  provider: Pick<ModelProvider, "streamChat">;
  /** Throws when the stored key cannot be read; null when there is none. */
  resolveApiKey(): Promise<string | null>;
  missions(): ContextMissionRuntime;
  /** Push to the renderer on IPC_CHANNELS.contextEvent. */
  push(event: ContextEvent): void;
  /** `buildCompactionPrompt` of @nova/agent-runtime. */
  prompt: CompactionPromptBuilder;
  /** `normalizeCompactionSummary` of @nova/agent-runtime. */
  normalize(text: string): string;
  /** `COMPACTION_SUMMARY_MAX_TOKENS` of @nova/agent-runtime. */
  summaryMaxTokens: number;
  now?: () => number;
  logger?: RuntimeLogger;
}

export interface ContextService {
  api: Omit<MainApi["context"], "onEvent">;
  /** Wire as `MainRuntimeHandlers.context` in the missions service's `connectRuntime`. */
  runtimeHook: LoopContextHook;
  /** Wire as `ChatRunnerDeps.historyForModel`. */
  historyForModel(conversationId: string, history: Message[]): AppliedConversationHistory | null;
  /** Call after a chat answer completes (`completed` chat event): pushes the conversation's usage. */
  observeConversation(conversationId: string): ContextUsage | null;
  /** Aborts summaries in flight (quit). */
  dispose(): void;
}

function toServiceError(error: unknown): unknown {
  if (error instanceof CompactionError) return new ServiceError(error.code, error.message);
  return error;
}

function proxyRefusal(error: ProxyError): CompactionError {
  switch (error.code) {
    case "budget":
    case "daily_budget":
      return new CompactionError("conflict", error.message);
    case "no_key":
      return new CompactionError("no_key", "no OpenRouter key");
    case "key_unreadable":
      return new CompactionError("key_unreadable", "the stored key cannot be read");
    case "aborted":
      return new CompactionError("conflict", "the summary was cancelled");
    default:
      return new CompactionError("provider", "the summary could not be written");
  }
}

export function createContextService(deps: ContextServiceDeps): ContextService {
  const summaries = createCompactionRepo(deps.store.db, deps.now);
  const missions = createMissionRepo(deps.store.db, deps.now);
  const model = (modelId: string) => deps.store.loadCatalog("openrouter")?.models.find((info) => info.id === modelId) ?? null;

  async function summarizeMission(request: SummarizeRequest & { target: { kind: "mission" } }, signal: AbortSignal): Promise<SummarizeResult> {
    let text = "";
    let costUsd: number | null = null;
    try {
      const stream = deps.missions().proxy.stream(
        {
          missionId: request.target.missionId,
          modelId: request.modelId,
          messages: request.messages,
          tools: [],
          webSearch: false,
          maxTokens: request.maxTokens,
          purpose: "step",
        },
        signal,
      );
      // Reasoning events are ignored: nothing of it is kept (ADR-008).
      for await (const event of stream) {
        if (event.type === "text") text += event.text;
        if (event.type === "usage") costUsd = event.usage.cost;
      }
    } catch (error) {
      if (error instanceof ProxyError) throw proxyRefusal(error);
      throw error;
    }
    return { text, costUsd };
  }

  async function summarizeConversation(request: SummarizeRequest, signal: AbortSignal): Promise<SummarizeResult> {
    let apiKey: string | null;
    try {
      apiKey = await deps.resolveApiKey();
    } catch {
      throw new CompactionError("key_unreadable", "the stored key cannot be read");
    }
    if (!apiKey) throw new CompactionError("no_key", "no OpenRouter key");
    let text = "";
    let costUsd: number | null = null;
    try {
      const stream = deps.provider.streamChat(apiKey, {
        modelId: request.modelId,
        messages: request.messages,
        signal,
        dataCollection: deps.store.getSettings().privacy.providerDataCollection,
        maxTokens: request.maxTokens,
      });
      for await (const event of stream) {
        if (event.type === "text") text += event.text;
        if (event.type === "usage") costUsd = event.usage.cost;
      }
    } catch (error) {
      if (error instanceof ProviderError) {
        deps.logger?.warn("conversation summary failed", { code: error.info.code });
        throw new CompactionError("provider", "the summary could not be written");
      }
      throw error;
    }
    return { text, costUsd };
  }

  const core = createCompactionCore({
    summaries,
    missions: {
      get: (id) => missions.get(id),
      setModel: (id, modelId) => missions.setModel(id, modelId),
      events: (id) => missions.listEvents(id).map(eventFromRecord),
      lastEventSeq: (id) => missions.listRecentEvents(id, 1)[0]?.seq ?? 0,
      tasks: (id) => missions.listTasks(id),
      isRunning: (id) => deps.missions().isRunning(id),
    },
    conversations: {
      get: (id) => deps.store.getConversation(id),
      messages: (id) => deps.store.listMessages(id),
    },
    model,
    journal: { append: (event) => deps.missions().journal.append(event) },
    summarize: (request, signal) =>
      request.target.kind === "mission"
        ? summarizeMission({ ...request, target: request.target }, signal)
        : summarizeConversation(request, signal),
    prompt: deps.prompt,
    normalize: deps.normalize,
    summaryMaxTokens: deps.summaryMaxTokens,
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.logger ? { logger: deps.logger } : {}),
  });
  core.onEvent(deps.push);

  const guard =
    <A, R>(fn: (arg: A) => R | Promise<R>) =>
    async (arg: A): Promise<Awaited<R>> => {
      try {
        return await fn(arg);
      } catch (error) {
        throw toServiceError(error);
      }
    };

  return {
    api: {
      usage: guard(({ target }) => core.usage(target)),
      compact: guard((req) => core.compact(req)),
      decide: guard((req) => core.decide(req)),
      list: guard(({ target }) => core.list(target)),
      handoff: guard((req) => core.handoff(req)),
    },
    runtimeHook: core.runtimeHook,
    historyForModel: (conversationId, history) => core.historyForModel(conversationId, history),
    observeConversation: (conversationId) => core.observeConversation(conversationId),
    dispose: () => core.dispose(),
  };
}
