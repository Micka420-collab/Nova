// Sandboxed preload: exposes the fixed NovaBridge API as `window.novaBridge`, nothing else.
// Only channel names are imported at runtime; shared types are erased (no zod in this bundle).
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { ChatStreamEvent, IpcResult, NovaBridge } from "@nova/shared";
import { IPC_CHANNELS } from "@nova/shared/channels";

/** Resolves with main's envelope; a transport failure (no handler, closing) becomes an internal error. */
async function invoke<T>(channel: string, payload?: unknown): Promise<IpcResult<T>> {
  try {
    return (await ipcRenderer.invoke(channel, payload)) as IpcResult<T>;
  } catch {
    return { ok: false, error: { code: "internal", message: "IPC call failed" } };
  }
}

const bridge: NovaBridge = {
  app: {
    info: () => invoke(IPC_CHANNELS.appInfo),
    openExternal: (req) => invoke(IPC_CHANNELS.appOpenExternal, req),
  },
  settings: {
    get: () => invoke(IPC_CHANNELS.settingsGet),
    update: (patch) => invoke(IPC_CHANNELS.settingsUpdate, patch),
  },
  connection: {
    get: (req) => invoke(IPC_CHANNELS.connectionGet, req),
    setKey: (req) => invoke(IPC_CHANNELS.connectionSetKey, req),
    test: (req) => invoke(IPC_CHANNELS.connectionTest, req),
    remove: (req) => invoke(IPC_CHANNELS.connectionRemove, req),
  },
  models: {
    catalog: (req) => invoke(IPC_CHANNELS.modelsCatalog, req),
  },
  conversations: {
    list: (req) => invoke(IPC_CHANNELS.conversationsList, req),
    get: (req) => invoke(IPC_CHANNELS.conversationsGet, req),
    rename: (req) => invoke(IPC_CHANNELS.conversationsRename, req),
    delete: (req) => invoke(IPC_CHANNELS.conversationsDelete, req),
  },
  chat: {
    send: (req) => invoke(IPC_CHANNELS.chatSend, req),
    stop: (req) => invoke(IPC_CHANNELS.chatStop, req),
    retry: (req) => invoke(IPC_CHANNELS.chatRetry, req),
    active: () => invoke(IPC_CHANNELS.chatActive),
    onEvent: (listener) => {
      // Forward the payload only: the IpcRendererEvent would expose `sender` (ipcRenderer).
      const relay = (_event: IpcRendererEvent, payload: ChatStreamEvent): void => listener(payload);
      ipcRenderer.on(IPC_CHANNELS.chatEvent, relay);
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.chatEvent, relay);
      };
    },
  },
};

contextBridge.exposeInMainWorld("novaBridge", bridge);
