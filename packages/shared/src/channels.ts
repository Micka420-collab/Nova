// IPC channel names. Kept dependency-free so the sandboxed preload bundle stays minimal.
export const IPC_CHANNELS = {
  appInfo: "nova:app:info",
  appOpenExternal: "nova:app:open-external",
  settingsGet: "nova:settings:get",
  settingsUpdate: "nova:settings:update",
  connectionGet: "nova:connection:get",
  connectionSetKey: "nova:connection:set-key",
  connectionTest: "nova:connection:test",
  connectionRemove: "nova:connection:remove",
  modelsCatalog: "nova:models:catalog",
  conversationsList: "nova:conversations:list",
  conversationsGet: "nova:conversations:get",
  conversationsRename: "nova:conversations:rename",
  conversationsDelete: "nova:conversations:delete",
  chatSend: "nova:chat:send",
  chatStop: "nova:chat:stop",
  chatRetry: "nova:chat:retry",
  chatActive: "nova:chat:active",
  /** main -> renderer push channel. */
  chatEvent: "nova:chat:event",
} as const;

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];
