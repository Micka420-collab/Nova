// Worker-side runtime: answers requests from main over process.parentPort.
// Each worker entry calls `serveWorker(name, handlers)`; `ping` is built in.
import type { MessagePortMain } from "electron";
import {
  isMainToWorker,
  type WorkerErrorCode,
  type WorkerName,
  type WorkerPong,
  type WorkerToMain,
} from "./protocol";

export interface HandlerContext {
  /** Ports transferred with the message (e.g. a terminal data port). */
  ports: readonly MessagePortMain[];
  /** Sends an event to main. */
  notify(method: string, params: unknown): void;
}

export type WorkerHandler = (params: unknown, context: HandlerContext) => unknown;

/** Thrown by handlers to answer with a specific error code (message must be secret-free). */
export class WorkerMethodError extends Error {
  constructor(
    readonly code: WorkerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "WorkerMethodError";
  }
}

export function serveWorker(name: WorkerName, handlers: Readonly<Record<string, WorkerHandler>>): void {
  const port = process.parentPort;
  const started = Date.now();
  const send = (message: WorkerToMain): void => port.postMessage(message);
  const notify = (method: string, params: unknown): void => send({ kind: "notify", method, params });

  const builtins: Record<string, WorkerHandler> = {
    ping: (): WorkerPong => ({
      worker: name,
      pid: process.pid,
      node: process.versions.node,
      electron: process.versions.electron ?? null,
      uptimeMs: Date.now() - started,
    }),
  };

  port.on("message", (event) => {
    const message: unknown = event.data;
    if (!isMainToWorker(message)) return;
    const handler = builtins[message.method] ?? handlers[message.method];
    const context: HandlerContext = { ports: event.ports, notify };
    if (message.kind === "notify") {
      if (handler) void Promise.resolve().then(() => handler(message.params, context)).catch(() => {});
      return;
    }
    const { id } = message;
    if (!handler) {
      send({ kind: "response", id, ok: false, error: { code: "unknown_method", message: message.method } });
      return;
    }
    Promise.resolve()
      .then(() => handler(message.params, context))
      .then(
        (result) => send({ kind: "response", id, ok: true, result }),
        (error: unknown) => {
          const code = error instanceof WorkerMethodError ? error.code : "failed";
          const text = error instanceof WorkerMethodError ? error.message : "worker method failed";
          send({ kind: "response", id, ok: false, error: { code, message: text } });
        },
      );
  });
  send({ kind: "ready", worker: name, pid: process.pid });
}
