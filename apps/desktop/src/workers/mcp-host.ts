// mcp-host utilityProcess: owns the stdio MCP servers (one child process each) through
// @nova/mcp's McpStdioHost. Its own environment is scrubbed by main (workers.ts scrubEnv); the
// secret values of a server arrive only inside that server's `mcp.connect` params and are never
// logged, echoed or returned (stderr and errors are redacted against them).
import { HostParamsError, McpStdioHost, createHostHandlers } from "@nova/mcp";
import type { WorkerNotify } from "./protocol";
import { serveWorker, WorkerMethodError, type WorkerHandler } from "./serve";

// Events are sent outside any request (list_changed, a crash), hence not via a handler context.
const notifyMain = (method: string, params: unknown): void => {
  const message: WorkerNotify = { kind: "notify", method, params };
  process.parentPort.postMessage(message);
};
const host = new McpStdioHost(notifyMain);

/** Validation failures answer `invalid_params` (the message names the field, never a value). */
function guarded(handler: (params: unknown) => unknown): WorkerHandler {
  return (params) => {
    try {
      return handler(params);
    } catch (error) {
      if (error instanceof HostParamsError) throw new WorkerMethodError("invalid_params", error.message);
      throw error;
    }
  };
}

const handlers = Object.fromEntries(
  Object.entries(createHostHandlers(host)).map(([method, handler]) => [method, guarded(handler)]),
);
serveWorker("mcp-host", handlers);

// Children must not outlive the host: close them when main stops this worker.
process.once("SIGTERM", () => {
  void host.closeAll().finally(() => process.exit(0));
});
