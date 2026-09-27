// stdio server host: runs inside the mcp-host utilityProcess and owns one child process per stdio
// server (spawned by the SDK transport). Main talks to it with the methods below (see
// MCP_HOST_METHODS); secrets arrive only inside `connect` params, for that spawn, and are never
// logged or sent back (stderr and errors are redacted against them).
import { connectMcpSession, type McpCallOutcome, type McpRawTool, type McpSession, type McpSessionInfo, type McpSessionOptions } from "./session";
import { stdioTransportFactory, type StdioLaunch } from "./transports";

export const MCP_HOST_METHODS = {
  connect: "mcp.connect",
  listTools: "mcp.listTools",
  callTool: "mcp.callTool",
  close: "mcp.close",
  stderr: "mcp.stderr",
  sessions: "mcp.sessions",
  /** notify (no answer): aborts an in-flight call. */
  cancel: "mcp.cancel",
} as const;

export const MCP_HOST_EVENTS = {
  /** params: McpSessionInfo */
  info: "mcp.info",
  /** params: { serverId: string; tools: McpRawTool[] } */
  tools: "mcp.tools",
} as const;

export interface HostConnectParams {
  serverId: string;
  launch: StdioLaunch;
  /** Names of `launch.env` entries whose values are secrets (masked from logs and errors). */
  secretEnvNames: string[];
  connectTimeoutMs: number | null;
  callTimeoutMs: number | null;
}

export interface HostConnectResult {
  info: McpSessionInfo;
  tools: McpRawTool[];
  stderrTail: string;
}

export interface HostCallParams {
  serverId: string;
  callId: string;
  name: string;
  args: Record<string, unknown>;
  timeoutMs: number | null;
}

export class HostParamsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HostParamsError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(record: Record<string, unknown>, key: string, max = 4_000): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0 || value.length > max) throw new HostParamsError(`invalid ${key}`);
  return value;
}

function optNumber(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new HostParamsError(`invalid ${key}`);
  return value;
}

function stringRecord(value: unknown, key: string): Record<string, string> {
  if (!isRecord(value)) throw new HostParamsError(`invalid ${key}`);
  const out: Record<string, string> = {};
  for (const [name, entry] of Object.entries(value)) {
    if (typeof entry !== "string") throw new HostParamsError(`invalid ${key}.${name}`);
    out[name] = entry;
  }
  return out;
}

export function parseConnectParams(params: unknown): HostConnectParams {
  if (!isRecord(params) || !isRecord(params["launch"])) throw new HostParamsError("invalid connect params");
  const launch = params["launch"];
  const args = launch["args"];
  if (!Array.isArray(args) || !args.every((arg) => typeof arg === "string")) throw new HostParamsError("invalid args");
  const cwd = launch["cwd"];
  if (cwd !== null && typeof cwd !== "string") throw new HostParamsError("invalid cwd");
  const secretEnvNames = params["secretEnvNames"];
  if (!Array.isArray(secretEnvNames) || !secretEnvNames.every((name) => typeof name === "string")) {
    throw new HostParamsError("invalid secretEnvNames");
  }
  return {
    serverId: str(params, "serverId", 200),
    launch: { command: str(launch, "command"), args, env: stringRecord(launch["env"], "env"), cwd },
    secretEnvNames,
    connectTimeoutMs: optNumber(params, "connectTimeoutMs"),
    callTimeoutMs: optNumber(params, "callTimeoutMs"),
  };
}

export function parseCallParams(params: unknown): HostCallParams {
  if (!isRecord(params) || !isRecord(params["args"])) throw new HostParamsError("invalid call params");
  return {
    serverId: str(params, "serverId", 200),
    callId: str(params, "callId", 200),
    name: str(params, "name", 200),
    args: params["args"],
    timeoutMs: optNumber(params, "timeoutMs"),
  };
}

export function parseServerId(params: unknown): string {
  if (!isRecord(params)) throw new HostParamsError("invalid params");
  return str(params, "serverId", 200);
}

export function parseCallId(params: unknown): string {
  if (!isRecord(params)) throw new HostParamsError("invalid params");
  return str(params, "callId", 200);
}

type Notify = (method: string, params: unknown) => void;
type Connect = (options: McpSessionOptions) => Promise<McpSession>;

export class McpStdioHost {
  private readonly sessions = new Map<string, McpSession>();
  /** Session kept after a failure or a close, so its stderr can still be read. */
  private readonly retired = new Map<string, McpSession>();
  private readonly calls = new Map<string, AbortController>();

  constructor(
    private readonly notify: Notify,
    private readonly connectSession: Connect = connectMcpSession,
  ) {}

  /** (Re)connects a server: an existing session for the same id is closed first. */
  async connect(params: HostConnectParams): Promise<HostConnectResult> {
    await this.close(params.serverId);
    const secretValues = params.secretEnvNames
      .map((name) => params.launch.env[name])
      .filter((value): value is string => typeof value === "string");
    const session = await this.connectSession({
      serverId: params.serverId,
      createTransport: stdioTransportFactory(params.launch),
      secretValues,
      ...(params.connectTimeoutMs ? { connectTimeoutMs: params.connectTimeoutMs } : {}),
      ...(params.callTimeoutMs ? { callTimeoutMs: params.callTimeoutMs } : {}),
      onInfo: (info) => this.notify(MCP_HOST_EVENTS.info, info),
      onToolsChanged: (tools) => this.notify(MCP_HOST_EVENTS.tools, { serverId: params.serverId, tools }),
    });
    if (session.info().state === "connected") this.sessions.set(params.serverId, session);
    else this.retired.set(params.serverId, session);
    return { info: session.info(), tools: session.tools(), stderrTail: session.stderrTail() };
  }

  async listTools(serverId: string, refresh: boolean): Promise<McpRawTool[]> {
    const session = this.sessions.get(serverId);
    if (!session) return [];
    return refresh ? session.refreshTools() : session.tools();
  }

  async callTool(params: HostCallParams): Promise<McpCallOutcome> {
    const session = this.sessions.get(params.serverId);
    if (!session) return { ok: false, code: "unavailable", message: "Le serveur n'est pas connecté.", durationMs: 0 };
    const controller = new AbortController();
    this.calls.set(params.callId, controller);
    try {
      return await session.callTool(params.name, params.args, {
        signal: controller.signal,
        ...(params.timeoutMs ? { timeoutMs: params.timeoutMs } : {}),
      });
    } finally {
      this.calls.delete(params.callId);
    }
  }

  cancel(callId: string): void {
    this.calls.get(callId)?.abort();
  }

  async close(serverId: string): Promise<void> {
    const session = this.sessions.get(serverId);
    this.sessions.delete(serverId);
    if (session) {
      await session.close();
      this.retired.set(serverId, session);
    }
  }

  stderr(serverId: string, lines = 50): string {
    return (this.sessions.get(serverId) ?? this.retired.get(serverId))?.stderrTail(lines) ?? "";
  }

  /** Infos of live sessions (a session whose server died reports `error`). */
  sessionInfos(): McpSessionInfo[] {
    return [...this.sessions.values()].map((session) => session.info());
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((serverId) => this.close(serverId)));
  }
}

/** Method table served by the mcp-host worker (validation errors throw HostParamsError). */
export function createHostHandlers(host: McpStdioHost): Record<string, (params: unknown) => unknown> {
  const flag = (params: unknown, key: string): unknown =>
    isRecord(params) ? params[key] : undefined;
  const lines = (params: unknown): number => {
    const value = flag(params, "lines");
    return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 200 ? value : 50;
  };
  return {
    [MCP_HOST_METHODS.connect]: (params) => host.connect(parseConnectParams(params)),
    [MCP_HOST_METHODS.listTools]: (params) => host.listTools(parseServerId(params), flag(params, "refresh") === true),
    [MCP_HOST_METHODS.callTool]: (params) => host.callTool(parseCallParams(params)),
    [MCP_HOST_METHODS.close]: (params) => host.close(parseServerId(params)),
    [MCP_HOST_METHODS.stderr]: (params) => host.stderr(parseServerId(params), lines(params)),
    [MCP_HOST_METHODS.sessions]: () => host.sessionInfos(),
    [MCP_HOST_METHODS.cancel]: (params) => host.cancel(parseCallId(params)),
  };
}
