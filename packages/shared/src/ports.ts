// MessagePort relay, renderer side.
//
// Why a relay: a sandboxed, context-isolated preload cannot hand a MessagePort to the page through
// contextBridge. Electron's documented pattern is used instead:
//   1. main: `const { port1, port2 } = new MessageChannelMain()`; port1 goes to the worker
//      (utilityProcess.postMessage(msg, [port1])); port2 goes to the window with
//      `webContents.postMessage(IPC_CHANNELS.portTransfer, envelope, [port2])`;
//   2. preload: `ipcRenderer.on(portTransfer, (e, envelope) => window.postMessage(
//      { type: NOVA_PORT_MESSAGE, ...envelope }, "*", e.ports))` (validated shape, one port);
//   3. page: this registry receives it and hands it to whoever `take`s that (kind, id).
// Ports may arrive before the IPC reply that announces their id (e.g. terminal.create), so they are
// buffered until claimed; unclaimed ports are closed after `unclaimedTtlMs`.
import { NOVA_PORT_MESSAGE, type NovaPortEnvelope, type NovaPortKind } from "./channels";

export interface NovaPortRegistry {
  /** Resolves with the port for (kind, id), waiting up to `timeoutMs` for it to arrive. */
  take(kind: NovaPortKind, id: string, timeoutMs?: number): Promise<MessagePort>;
  dispose(): void;
}

interface PortWindowMessage extends NovaPortEnvelope {
  type: typeof NOVA_PORT_MESSAGE;
}

export function isNovaPortMessage(data: unknown): data is PortWindowMessage {
  if (typeof data !== "object" || data === null) return false;
  const record = data as Record<string, unknown>;
  return record["type"] === NOVA_PORT_MESSAGE && typeof record["kind"] === "string" && typeof record["id"] === "string";
}

const DEFAULT_TAKE_TIMEOUT_MS = 10_000;

export function createNovaPortRegistry(
  target: Pick<Window, "addEventListener" | "removeEventListener">,
  options: { unclaimedTtlMs?: number } = {},
): NovaPortRegistry {
  const unclaimedTtlMs = options.unclaimedTtlMs ?? 30_000;
  const buffered = new Map<string, { port: MessagePort; timer: ReturnType<typeof setTimeout> }>();
  const waiters = new Map<string, (port: MessagePort) => void>();
  const key = (kind: string, id: string): string => `${kind}:${id}`;

  const onMessage = (event: MessageEvent): void => {
    // Only the preload (same window) posts these; anything else is ignored.
    if (event.source !== null && event.source !== (target as unknown)) return;
    if (!isNovaPortMessage(event.data) || event.ports.length !== 1) return;
    const port = event.ports[0];
    if (!port) return;
    const k = key(event.data.kind, event.data.id);
    const waiter = waiters.get(k);
    if (waiter) {
      waiters.delete(k);
      waiter(port);
      return;
    }
    buffered.get(k)?.port.close();
    clearTimeout(buffered.get(k)?.timer);
    const timer = setTimeout(() => {
      buffered.get(k)?.port.close();
      buffered.delete(k);
    }, unclaimedTtlMs);
    buffered.set(k, { port, timer });
  };
  target.addEventListener("message", onMessage as EventListener);

  return {
    take(kind, id, timeoutMs = DEFAULT_TAKE_TIMEOUT_MS) {
      const k = key(kind, id);
      const ready = buffered.get(k);
      if (ready) {
        clearTimeout(ready.timer);
        buffered.delete(k);
        return Promise.resolve(ready.port);
      }
      return new Promise<MessagePort>((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters.delete(k);
          reject(new Error(`No ${kind} port received for ${id}`));
        }, timeoutMs);
        waiters.set(k, (port) => {
          clearTimeout(timer);
          resolve(port);
        });
      });
    },
    dispose() {
      target.removeEventListener("message", onMessage as EventListener);
      for (const { port, timer } of buffered.values()) {
        clearTimeout(timer);
        port.close();
      }
      buffered.clear();
      waiters.clear();
    },
  };
}
