// IPC routing without Electron: channel -> schema-validated call -> IpcResult envelope.
// Handlers never throw across IPC; every failure becomes a typed IpcError.
import { RuntimeError, type RuntimeErrorCode, type RuntimeLogger } from "@nova/agent-runtime";
import { ProviderError } from "@nova/providers";
import {
  CatalogRequestSchema,
  ChatRetryRequestSchema,
  ChatSendRequestSchema,
  ChatStopRequestSchema,
  ConversationIdRequestSchema,
  IPC_CHANNELS,
  ListConversationsRequestSchema,
  OpenExternalRequestSchema,
  ProviderRequestSchema,
  RenameConversationRequestSchema,
  SetKeyRequestSchema,
  SettingsPatchSchema,
  redactSecrets,
  type IpcChannel,
  type IpcError,
  type IpcErrorCode,
  type IpcResult,
} from "@nova/shared";
import { z } from "zod";
import type { MainApi } from "./api";
import { describeError } from "./logger";
import { ServiceError } from "./service-error";
import { VaultError } from "./vault";

export interface IpcRoute {
  channel: IpcChannel;
  handle(payload: unknown): Promise<IpcResult<unknown>>;
}

const RUNTIME_CODES: Readonly<Record<RuntimeErrorCode, IpcErrorCode>> = {
  no_key: "no_key",
  not_found: "not_found",
  conflict: "conflict",
  invalid_state: "conflict",
};

/** Maps any failure to an IpcError. Messages are short, fixed or redacted; payloads are never echoed. */
export function toIpcError(error: unknown): IpcError {
  if (error instanceof ProviderError) {
    return { code: "provider", message: `Provider error: ${error.info.code}`, providerError: error.info };
  }
  if (error instanceof RuntimeError) return { code: RUNTIME_CODES[error.code], message: error.message };
  if (error instanceof ServiceError) return { code: error.code, message: error.message };
  if (error instanceof VaultError) return { code: "vault_unavailable", message: error.message };
  if (error instanceof z.ZodError) return { code: "invalid_request", message: "Invalid request" };
  return { code: "internal", message: "Internal error" };
}

/** Field paths only: issue messages and values may quote the payload (keys included). */
function describeIssues(error: z.ZodError): string {
  const paths = [...new Set(error.issues.map((issue) => issue.path.map(String).join(".") || "(root)"))];
  return `Invalid request: ${paths.join(", ")}`.slice(0, 200);
}

const NoPayloadSchema = z.undefined();

export function buildIpcRoutes(api: MainApi, logger: RuntimeLogger): IpcRoute[] {
  const route = <S extends z.ZodType, R>(
    channel: IpcChannel,
    schema: S,
    run: (req: z.output<S>) => Promise<R>,
  ): IpcRoute => ({
    channel,
    handle: async (payload) => {
      const parsed = schema.safeParse(payload);
      if (!parsed.success) {
        const message = describeIssues(parsed.error);
        logger.warn("ipc request rejected", { channel, reason: message });
        return { ok: false, error: { code: "invalid_request", message } };
      }
      try {
        return { ok: true, value: await run(parsed.data) };
      } catch (error) {
        const ipcError = toIpcError(error);
        if (ipcError.code === "internal") {
          logger.error("ipc handler failed", { channel, error: redactSecrets(describeError(error)) });
        } else {
          logger.info("ipc request refused", { channel, code: ipcError.code, provider: ipcError.providerError?.code });
        }
        return { ok: false, error: ipcError };
      }
    },
  });

  return [
    route(IPC_CHANNELS.appInfo, NoPayloadSchema, () => api.app.info()),
    route(IPC_CHANNELS.appOpenExternal, OpenExternalRequestSchema, (req) => api.app.openExternal(req)),
    route(IPC_CHANNELS.settingsGet, NoPayloadSchema, () => api.settings.get()),
    route(IPC_CHANNELS.settingsUpdate, SettingsPatchSchema, (patch) => api.settings.update(patch)),
    route(IPC_CHANNELS.connectionGet, ProviderRequestSchema, (req) => api.connection.get(req)),
    route(IPC_CHANNELS.connectionSetKey, SetKeyRequestSchema, (req) => api.connection.setKey(req)),
    route(IPC_CHANNELS.connectionTest, ProviderRequestSchema, (req) => api.connection.test(req)),
    route(IPC_CHANNELS.connectionRemove, ProviderRequestSchema, (req) => api.connection.remove(req)),
    route(IPC_CHANNELS.modelsCatalog, CatalogRequestSchema, (req) => api.models.catalog(req)),
    route(IPC_CHANNELS.conversationsList, ListConversationsRequestSchema, (req) => api.conversations.list(req)),
    route(IPC_CHANNELS.conversationsGet, ConversationIdRequestSchema, (req) => api.conversations.get(req)),
    route(IPC_CHANNELS.conversationsRename, RenameConversationRequestSchema, (req) =>
      api.conversations.rename(req),
    ),
    route(IPC_CHANNELS.conversationsDelete, ConversationIdRequestSchema, (req) => api.conversations.delete(req)),
    route(IPC_CHANNELS.chatSend, ChatSendRequestSchema, (req) => api.chat.send(req)),
    route(IPC_CHANNELS.chatStop, ChatStopRequestSchema, (req) => api.chat.stop(req)),
    route(IPC_CHANNELS.chatRetry, ChatRetryRequestSchema, (req) => api.chat.retry(req)),
    route(IPC_CHANNELS.chatActive, NoPayloadSchema, () => api.chat.active()),
  ];
}
