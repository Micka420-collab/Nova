// Main-process implementation of NovaApi (minus the push channel), over the services.
import type { ChatRunner } from "@nova/agent-runtime";
import type { NovaApi } from "@nova/shared";
import type { NovaStore } from "@nova/storage";
import { ServiceError } from "./service-error";
import type { AppService } from "./services/app-service";
import type { CatalogService } from "./services/catalog-service";
import type { ChatEventHub } from "./services/chat-events";
import type { ConnectionService } from "./services/connection-service";

export type MainApi = { [G in keyof NovaApi]: Omit<NovaApi[G], "onEvent"> };

export interface MainApiDeps {
  store: NovaStore;
  runner: Pick<ChatRunner, "send" | "retry" | "stop" | "active">;
  connections: Pick<ConnectionService, "get" | "setKey" | "test" | "remove">;
  catalog: Pick<CatalogService, "catalog">;
  app: AppService;
  chatEvents: Pick<ChatEventHub, "waitForEnd">;
  /** Bound on waiting for a stopped stream to persist before deleting its conversation. */
  stopTimeoutMs?: number;
}

const DEFAULT_STOP_TIMEOUT_MS = 5_000;

function notFound(what: string): ServiceError {
  return new ServiceError("not_found", `${what} not found`);
}

export function createMainApi(deps: MainApiDeps): MainApi {
  const { store, runner, connections, catalog, chatEvents } = deps;
  const stopTimeoutMs = deps.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
  return {
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
          messages: store.listMessages(conversationId),
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
      stop: async ({ streamId }) => {
        if (!runner.stop(streamId)) throw notFound("Active stream");
      },
      retry: (req) => runner.retry(req),
      active: async () => runner.active(),
    },
  };
}
