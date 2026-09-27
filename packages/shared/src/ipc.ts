// Typed IPC contract between the renderer (untrusted UI) and the Electron main process.
// Every request payload is validated with these schemas in main before use.
import { z } from "zod";
import type {
  AppInfo,
  AppSettings,
  Conversation,
  ConversationDetail,
  ConversationSummary,
  Message,
  ModelCatalog,
  ProviderConnectionView,
  ProviderErrorInfo,
  UsageSummary,
} from "./domain";

export { IPC_CHANNELS, type IpcChannel } from "./channels";

// ---------------------------------------------------------------------------
// Request schemas

const providerId = z.literal("openrouter");
const entityId = z.uuid();
/** Model ids look like `author/model-name[:variant]`; kept permissive but bounded. */
const modelId = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[\w.\-~]+\/[\w.\-:~@]+$/, "identifiant de modèle invalide");

export const ProviderRequestSchema = z.object({ providerId });

export const SetKeyRequestSchema = z.object({
  providerId,
  apiKey: z
    .string()
    .trim()
    .min(8)
    .max(512)
    .regex(/^\S+$/, "la clé ne doit pas contenir d'espaces"),
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

export const ChatSendRequestSchema = z.object({
  conversationId: entityId.nullable(),
  content: z.string().trim().min(1).max(100_000),
  modelId,
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
  | "provider"
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
    list(req: ListConversationsRequest): Promise<ConversationSummary[]>;
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
  };
}
