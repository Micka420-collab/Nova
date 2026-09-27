// Registers the IPC routes on ipcMain, rejecting any sender that is not the app page.
import { ipcMain, type WebFrameMain } from "electron";
import type { IpcResult } from "@nova/shared";
import type { IpcRoute } from "./ipc-routes";
import type { Logger } from "./logger";

const SENDER_REJECTED: IpcResult<never> = {
  ok: false,
  error: { code: "invalid_request", message: "Sender not allowed" },
};

export function registerIpcRoutes(
  routes: readonly IpcRoute[],
  isTrustedSender: (frame: WebFrameMain | null) => boolean,
  logger: Logger,
): void {
  for (const route of routes) {
    ipcMain.handle(route.channel, (event, payload: unknown) => {
      if (!isTrustedSender(event.senderFrame)) {
        logger.warn("ipc sender rejected", { channel: route.channel });
        return SENDER_REJECTED;
      }
      return route.handle(payload);
    });
  }
}
