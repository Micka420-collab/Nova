// Message protocol between main and its utilityProcess workers (over process.parentPort).
// Pure types and guards: imported by main (workers.ts) and by every worker entry.
//
// - main → worker: `request` (expects exactly one `response` with the same id) or `notify`.
// - worker → main: `response`, `notify` (events), or `ready` once, when the worker listens.
// MessagePorts (terminal data, LSP transports…) travel as `transfer` of a request/notify; the
// worker receives them in `ports` of the handler context.

export const WORKER_NAMES = ["pty-host", "fs-worker", "agent-runtime", "mcp-host"] as const;
export type WorkerName = (typeof WORKER_NAMES)[number];

export interface WorkerRequest {
  kind: "request";
  id: number;
  method: string;
  params: unknown;
}

export interface WorkerNotify {
  kind: "notify";
  method: string;
  params: unknown;
}

export type WorkerErrorCode = "unknown_method" | "invalid_params" | "not_found" | "failed" | "unavailable";

export type WorkerResponse =
  | { kind: "response"; id: number; ok: true; result: unknown }
  | { kind: "response"; id: number; ok: false; error: { code: WorkerErrorCode; message: string } };

export interface WorkerReady {
  kind: "ready";
  worker: WorkerName;
  pid: number;
}

export type MainToWorker = WorkerRequest | WorkerNotify;
export type WorkerToMain = WorkerResponse | WorkerNotify | WorkerReady;

/** Answer of the built-in `ping` method every worker implements. */
export interface WorkerPong {
  worker: WorkerName;
  pid: number;
  node: string;
  electron: string | null;
  uptimeMs: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isWorkerToMain(value: unknown): value is WorkerToMain {
  if (!isRecord(value)) return false;
  switch (value["kind"]) {
    case "response":
      return typeof value["id"] === "number" && typeof value["ok"] === "boolean";
    case "notify":
      return typeof value["method"] === "string";
    case "ready":
      return typeof value["worker"] === "string" && typeof value["pid"] === "number";
    default:
      return false;
  }
}

export function isMainToWorker(value: unknown): value is MainToWorker {
  if (!isRecord(value)) return false;
  if (value["kind"] === "request") return typeof value["id"] === "number" && typeof value["method"] === "string";
  if (value["kind"] === "notify") return typeof value["method"] === "string";
  return false;
}
