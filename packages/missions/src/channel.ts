// Bidirectional RPC over one message port (main ⇄ agent-runtime). Requests may stream partial
// events before their single response, may be cancelled by the caller (the handler's signal
// aborts), and are all rejected when the port closes. Transport-agnostic: `PortLike` adapts an
// Electron MessagePortMain on either side, or an in-memory pair in tests.

export interface PortLike {
  postMessage(message: unknown): void;
  /** Subscribes to incoming messages; returns an unsubscribe function. */
  onMessage(listener: (message: unknown) => void): () => void;
  /** Called once when the other side goes away. */
  onClose(listener: () => void): () => void;
  close(): void;
}

type Wire =
  | { kind: "request"; id: number; method: string; params: unknown }
  | { kind: "stream"; id: number; event: unknown }
  | { kind: "response"; id: number; ok: true; result: unknown }
  | { kind: "response"; id: number; ok: false; error: { code: string; message: string; retryable: boolean } }
  | { kind: "cancel"; id: number }
  | { kind: "notify"; method: string; params: unknown };

export interface HandlerContext {
  signal: AbortSignal;
  /** Sends a partial event to the caller (before the response). */
  stream(event: unknown): void;
}

export type ChannelHandler = (params: unknown, context: HandlerContext) => unknown;

/** Error crossing the channel: `code` and `retryable` survive, the message is secret-free text. */
export class ChannelError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "ChannelError";
  }
}

export interface Channel {
  request<T = unknown>(
    method: string,
    params: unknown,
    options?: { signal?: AbortSignal; onStream?: (event: unknown) => void },
  ): Promise<T>;
  notify(method: string, params: unknown): void;
  /** Resolves when the port closed (either side). */
  readonly closed: Promise<void>;
  close(): void;
}

function isWire(value: unknown): value is Wire {
  if (typeof value !== "object" || value === null) return false;
  const kind = (value as { kind?: unknown }).kind;
  return kind === "request" || kind === "stream" || kind === "response" || kind === "cancel" || kind === "notify";
}

function errorPayload(error: unknown): { code: string; message: string; retryable: boolean } {
  if (typeof error === "object" && error !== null) {
    const record = error as { code?: unknown; message?: unknown; retryable?: unknown };
    if (typeof record.code === "string") {
      return {
        code: record.code,
        message: typeof record.message === "string" ? record.message.slice(0, 1_000) : record.code,
        retryable: record.retryable === true,
      };
    }
  }
  return { code: "internal", message: "handler failed", retryable: false };
}

export function createChannel(
  port: PortLike,
  handlers: Readonly<Record<string, ChannelHandler>>,
  notifications: Readonly<Record<string, (params: unknown) => void>> = {},
): Channel {
  let nextId = 1;
  let isClosed = false;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; onStream?: (event: unknown) => void }>();
  const running = new Map<number, AbortController>();
  let markClosed: () => void = () => undefined;
  const closed = new Promise<void>((resolve) => {
    markClosed = resolve;
  });

  const send = (message: Wire): void => {
    if (!isClosed) port.postMessage(message);
  };

  const shutdown = (): void => {
    if (isClosed) return;
    isClosed = true;
    for (const entry of pending.values()) entry.reject(new ChannelError("unavailable", "channel closed", true));
    pending.clear();
    for (const controller of running.values()) controller.abort();
    running.clear();
    unsubscribe();
    unsubscribeClose();
    markClosed();
  };

  const handleRequest = (message: Extract<Wire, { kind: "request" }>): void => {
    const handler = handlers[message.method];
    if (!handler) {
      send({ kind: "response", id: message.id, ok: false, error: { code: "unknown_method", message: message.method, retryable: false } });
      return;
    }
    const controller = new AbortController();
    running.set(message.id, controller);
    const context: HandlerContext = {
      signal: controller.signal,
      stream: (event) => send({ kind: "stream", id: message.id, event }),
    };
    Promise.resolve()
      .then(() => handler(message.params, context))
      .then(
        (result) => send({ kind: "response", id: message.id, ok: true, result: result ?? null }),
        (error: unknown) => send({ kind: "response", id: message.id, ok: false, error: errorPayload(error) }),
      )
      .finally(() => running.delete(message.id));
  };

  const unsubscribe = port.onMessage((raw) => {
    if (!isWire(raw)) return;
    switch (raw.kind) {
      case "request":
        handleRequest(raw);
        return;
      case "cancel":
        running.get(raw.id)?.abort();
        return;
      case "stream":
        pending.get(raw.id)?.onStream?.(raw.event);
        return;
      case "response": {
        const entry = pending.get(raw.id);
        if (!entry) return;
        pending.delete(raw.id);
        if (raw.ok) entry.resolve(raw.result);
        else entry.reject(new ChannelError(raw.error.code, raw.error.message, raw.error.retryable));
        return;
      }
      case "notify":
        try {
          notifications[raw.method]?.(raw.params);
        } catch {
          // A faulty notification handler must not break the channel.
        }
        return;
    }
  });
  const unsubscribeClose = port.onClose(shutdown);

  return {
    request<T>(method: string, params: unknown, options: { signal?: AbortSignal; onStream?: (event: unknown) => void } = {}) {
      if (isClosed) return Promise.reject(new ChannelError("unavailable", "channel closed", true));
      const { signal, onStream } = options;
      if (signal?.aborted) return Promise.reject(new ChannelError("aborted", "aborted"));
      const id = nextId++;
      return new Promise<T>((resolve, reject) => {
        const onAbort = (): void => send({ kind: "cancel", id });
        signal?.addEventListener("abort", onAbort, { once: true });
        const settle = <A extends unknown[]>(fn: (...args: A) => void) => (...args: A): void => {
          signal?.removeEventListener("abort", onAbort);
          fn(...args);
        };
        pending.set(id, {
          resolve: settle((value: unknown) => resolve(value as T)),
          reject: settle((error: Error) => reject(error)),
          ...(onStream ? { onStream } : {}),
        });
        send({ kind: "request", id, method, params });
      });
    },
    notify(method, params) {
      send({ kind: "notify", method, params });
    },
    closed,
    close() {
      port.close();
      shutdown();
    },
  };
}

/** Two connected in-memory ports (tests, and in-process wiring). Messages are delivered async. */
export function createPortPair(): [PortLike, PortLike] {
  const listeners: [Set<(message: unknown) => void>, Set<(message: unknown) => void>] = [new Set(), new Set()];
  const closeListeners: [Set<() => void>, Set<() => void>] = [new Set(), new Set()];
  let open = true;
  const close = (): void => {
    if (!open) return;
    open = false;
    queueMicrotask(() => {
      for (const set of closeListeners) for (const listener of [...set]) listener();
    });
  };
  const side = (self: 0 | 1): PortLike => {
    const other = self === 0 ? 1 : 0;
    return {
      postMessage(message) {
        if (!open) return;
        // structuredClone mimics the real port (no shared references across processes).
        const copy = structuredClone(message);
        queueMicrotask(() => {
          if (open) for (const listener of [...listeners[other]]) listener(copy);
        });
      },
      onMessage(listener) {
        listeners[self].add(listener);
        return () => listeners[self].delete(listener);
      },
      onClose(listener) {
        closeListeners[self].add(listener);
        return () => closeListeners[self].delete(listener);
      },
      close,
    };
  };
  return [side(0), side(1)];
}
