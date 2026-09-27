// Adapts an Electron MessagePortMain (main process or utilityProcess side) to the transport of
// the mission channel (@nova/missions `PortLike`).
import type { MessagePortMain } from "electron";
import type { PortLike } from "@nova/missions";

export function portFromMessagePortMain(port: MessagePortMain): PortLike {
  const adapter: PortLike = {
    postMessage: (message) => port.postMessage(message),
    onMessage(listener) {
      const handler = (event: { data: unknown }): void => listener(event.data);
      port.on("message", handler);
      return () => port.off("message", handler);
    },
    onClose(listener) {
      port.on("close", listener);
      return () => port.off("close", listener);
    },
    close: () => port.close(),
  };
  // Queued messages are delivered on the next ticks, after the channel subscribed synchronously.
  port.start();
  return adapter;
}
