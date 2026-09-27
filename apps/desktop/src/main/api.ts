// Main-process implementation of NovaApi (minus the push channel), over the services.
import type { ChatRunner } from "@nova/agent-runtime";
import type { NovaApi } from "@nova/shared";
import type { NovaStore } from "@nova/storage";
import { ServiceError } from "./service-error";
import type { AppService } from "./services/app-service";
import type { CatalogService } from "./services/catalog-service";
import type { ChatEventHub } from "./services/chat-events";
import type { ConnectionService } from "./services/connection-service";
import { unavailableAtelierApi, type AtelierApi } from "./services/unavailable";

export type MainApi = { [G in keyof NovaApi]: Omit<NovaApi[G], "onEvent"> };

export interface MainApiDeps {
  store: NovaStore;
  runner: Pick<ChatRunner, "send" | "retry" | "stop" | "active" | "overlayLive">;
  connections: Pick<ConnectionService, "get" | "setKey" | "test" | "remove">;
  catalog: Pick<CatalogService, "catalog">;
  app: AppService;
  chatEvents: Pick<ChatEventHub, "waitForEnd">;
  /** Bound on waiting for a stopped stream to persist before deleting its conversation. */
  stopTimeoutMs?: number;
  /**
   * J2-A groups implemented so far. A group left out answers every call with the `unavailable`
   * IPC error (services/unavailable.ts); feature work adds its group here.
   */
  atelier?: Partial<AtelierApi>;
}

const DEFAULT_STOP_TIMEOUT_MS = 5_000;

function notFound(what: string): ServiceError {
  return new ServiceError("not_found", `${what} not found`);
}

export function createMainApi(deps: MainApiDeps): MainApi {
  const { store, runner, connections, catalog, chatEvents } = deps;
  const stopTimeoutMs = deps.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
  return {
    ...unavailableAtelierApi(),
    ...deps.atelier,
    app: deps.app,
    settings: {
      get: async () => store.getSettings(),
      update: async (patch) => store.updateSettings(patch),
    },
    connection: {
      get: async () => connections.get(),
      setKey: (req) => connections.setKey(req),
      test: () => connections.test(),
      remove: () => connections.remove(),
    },
    models: {
      catalog: (req) => catalog.catalog(req),
    },
    conversations: {
      list: async (req) => store.listConversations(req),
      get: async ({ conversationId }) => {
        const conversation = store.getConversation(conversationId);
        if (!conversation) throw notFound("Conversation");
        return {
          conversation,
          // Live text of a running answer: every delta emitted after this reply is new to the reader.
          messages: runner.overlayLive(store.listMessages(conversationId)),
          usage: store.conversationUsage(conversationId),
        };
      },
      rename: async ({ conversationId, title }) => {
        const conversation = store.renameConversation(conversationId, title);
        if (!conversation) throw notFound("Conversation");
        return conversation;
      },
      delete: async ({ conversationId }) => {
        // Stop its generation and let the runner persist the outcome before the rows disappear.
        const streams = runner.active().filter((stream) => stream.conversationId === conversationId);
        const ended = Promise.all(streams.map((stream) => chatEvents.waitForEnd(stream.streamId, stopTimeoutMs)));
        for (const stream of streams) runner.stop(stream.streamId);
        await ended;
        if (!store.deleteConversation(conversationId)) throw notFound("Conversation");
      },
    },
    chat: {
      send: (req) => runner.send(req),
      // Idempotent: a stream that already ended (the click raced its terminal event) is stopped.
      stop: async ({ streamId }) => {
        runner.stop(streamId);
      },
      retry: (req) => runner.retry(req),
      active: async () => runner.active(),
    },
  };
}
