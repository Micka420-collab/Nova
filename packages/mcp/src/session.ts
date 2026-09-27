// One live connection to one MCP server, on the official SDK (`Client`): version negotiation,
// tool listing (paginated, sorted, bounded), `tools/list_changed` refresh, calls with timeout,
// cancellation and output caps. Runs wherever the transport lives: stdio in the mcp-host
// utilityProcess, Streamable HTTP in main. Never throws for server failures: they become a state
// (`error`/`timeout`) or a call outcome, so a crashed server can never hang its caller.
//
// Not enabled on purpose: sampling, elicitation, roots (no client capabilities are declared, so
// server→client requests of those kinds are answered "method not found" by the SDK).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  ErrorCode,
  McpError,
  type JSONRPCMessage,
  type MessageExtraInfo,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { TOOL_LIMITS, type JsonSchema, type McpServerState, type McpToolAnnotations } from "@nova/shared";
import { StderrLog } from "./stderr-log";

/** A tool as listed by the server, normalized and bounded. All text is UNTRUSTED. */
export interface McpRawTool {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  annotations: McpToolAnnotations;
}

export interface McpSessionInfo {
  serverId: string;
  state: McpServerState;
  /** Negotiated protocol version; null until connected. */
  protocolVersion: string | null;
  /** `name version` reported by the server (untrusted, display only). */
  serverInfo: string | null;
  /** Time from spawn/first request to a listed tool set; null until connected. */
  connectLatencyMs: number | null;
  toolCount: number | null;
  /** Short French message, redacted; null when none. */
  lastError: string | null;
  updatedAt: number;
}

export type McpCallErrorCode = "timeout" | "cancelled" | "unavailable" | "not_found" | "invalid_arguments" | "failed";

/** Serializable outcome of a tool call (it crosses the worker boundary). */
export type McpCallOutcome =
  | { ok: true; isError: boolean; text: string; truncated: boolean; durationMs: number }
  | { ok: false; code: McpCallErrorCode; message: string; durationMs: number };

export interface McpCallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface McpSession {
  readonly serverId: string;
  info(): McpSessionInfo;
  /** Last listed tools, sorted by name. */
  tools(): McpRawTool[];
  refreshTools(): Promise<McpRawTool[]>;
  callTool(name: string, args: Record<string, unknown>, options?: McpCallOptions): Promise<McpCallOutcome>;
  /** Last stderr lines, redacted (stdio only; empty otherwise). */
  stderrTail(lines?: number): string;
  close(): Promise<void>;
}

export interface McpSessionOptions {
  serverId: string;
  /** Creates the SDK transport; `stderr` receives the server's stderr chunks when there is one. */
  createTransport(stderr: (chunk: string) => void): Transport;
  /** Resolved secret values, masked from stderr and error messages. */
  secretValues?: readonly string[];
  connectTimeoutMs?: number;
  callTimeoutMs?: number;
  maxResultChars?: number;
  onInfo?(info: McpSessionInfo): void;
  onToolsChanged?(tools: McpRawTool[]): void;
  now?(): number;
}

export const MCP_DEFAULTS = {
  connectTimeoutMs: 30_000,
  callTimeoutMs: 120_000,
  /** Bounds on what a server can make us hold (untrusted input). */
  maxTools: 500,
  maxPages: 20,
  maxDescriptionChars: 4_000,
  maxToolNameChars: 200,
  maxErrorChars: 300,
} as const;

const CLIENT_INFO = { name: "NOVA", version: "0.1.0" };

/**
 * Transport wrapper that records the negotiated protocol version: the SDK passes it to
 * `setProtocolVersion` after `initialize` (HTTP transports need it for their headers). Everything
 * else is delegated untouched — the protocol itself stays the SDK's.
 */
class VersionRecordingTransport implements Transport {
  protocolVersion: string | null = null;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void;

  constructor(private readonly inner: Transport) {}

  get sessionId(): string | undefined {
    return this.inner.sessionId;
  }

  start(): Promise<void> {
    this.inner.onclose = () => this.onclose?.();
    this.inner.onerror = (error) => this.onerror?.(error);
    this.inner.onmessage = (message, extra) => this.onmessage?.(message, extra);
    return this.inner.start();
  }

  send(message: JSONRPCMessage, options?: Parameters<Transport["send"]>[1]): Promise<void> {
    return this.inner.send(message, options);
  }

  close(): Promise<void> {
    return this.inner.close();
  }

  setProtocolVersion(version: string): void {
    this.protocolVersion = version;
    this.inner.setProtocolVersion?.(version);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeAnnotations(raw: Tool["annotations"]): McpToolAnnotations {
  const out: McpToolAnnotations = {};
  if (!raw) return out;
  if (typeof raw.title === "string") out.title = raw.title.slice(0, 200);
  for (const key of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const) {
    const value = raw[key];
    if (typeof value === "boolean") out[key] = value;
  }
  return out;
}

function normalizeTool(tool: Tool): McpRawTool | null {
  if (typeof tool.name !== "string" || tool.name.length === 0 || tool.name.length > MCP_DEFAULTS.maxToolNameChars) {
    return null;
  }
  const schema: JsonSchema = isRecord(tool.inputSchema) ? { ...tool.inputSchema } : { type: "object" };
  return {
    name: tool.name,
    description: (tool.description ?? "").slice(0, MCP_DEFAULTS.maxDescriptionChars),
    inputSchema: schema,
    annotations: normalizeAnnotations(tool.annotations),
  };
}

/** Text the model receives for a tool result: text blocks verbatim, binary content summarized. */
export function renderToolContent(result: Record<string, unknown>): string {
  const content = Array.isArray(result["content"]) ? (result["content"] as unknown[]) : [];
  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    const type = block["type"];
    if (type === "text" && typeof block["text"] === "string") parts.push(block["text"]);
    else if (type === "image" || type === "audio") {
      const mime = typeof block["mimeType"] === "string" ? block["mimeType"] : "unknown type";
      parts.push(`[${type} (${mime}) omitted]`);
    } else if (type === "resource_link") {
      parts.push(`[resource link: ${String(block["uri"] ?? "")}]`);
    } else if (type === "resource" && isRecord(block["resource"])) {
      const resource = block["resource"];
      parts.push(
        typeof resource["text"] === "string"
          ? resource["text"]
          : `[binary resource ${String(resource["uri"] ?? "")} omitted]`,
      );
    }
  }
  if (parts.length === 0 && result["structuredContent"] !== undefined) {
    parts.push(JSON.stringify(result["structuredContent"]));
  }
  if (parts.length === 0 && result["toolResult"] !== undefined) parts.push(JSON.stringify(result["toolResult"]));
  return parts.join("\n");
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "unknown error";
}

/** French, short, user-facing reason for a failed connection. */
function connectFailure(error: unknown): { state: "error" | "timeout"; message: string } {
  if (error instanceof McpError && error.code === ErrorCode.RequestTimeout) {
    return { state: "timeout", message: "Le serveur n'a pas répondu à temps." };
  }
  const code = isRecord(error) && typeof error["code"] === "string" ? error["code"] : null;
  if (code === "ENOENT") return { state: "error", message: "Commande introuvable." };
  if (code === "EACCES") return { state: "error", message: "Commande non exécutable (permission refusée)." };
  if (error instanceof McpError && error.code === ErrorCode.ConnectionClosed) {
    return { state: "error", message: "Le serveur s'est arrêté pendant la connexion." };
  }
  return { state: "error", message: `Connexion impossible : ${errorMessage(error)}` };
}

/**
 * Connects and lists tools. Always resolves: check `info().state` (`connected`, `error`,
 * `timeout`). A failed session keeps its stderr tail for the manager's log view.
 */
export async function connectMcpSession(options: McpSessionOptions): Promise<McpSession> {
  const now = options.now ?? Date.now;
  const connectTimeoutMs = options.connectTimeoutMs ?? MCP_DEFAULTS.connectTimeoutMs;
  const callTimeoutMs = options.callTimeoutMs ?? MCP_DEFAULTS.callTimeoutMs;
  const maxResultChars = options.maxResultChars ?? TOOL_LIMITS.resultMaxChars;
  const log = new StderrLog(options.secretValues ?? []);
  const bound = (text: string): string => {
    const redacted = log.redact(text);
    return redacted.length > MCP_DEFAULTS.maxErrorChars ? `${redacted.slice(0, MCP_DEFAULTS.maxErrorChars)}…` : redacted;
  };

  let info: McpSessionInfo = {
    serverId: options.serverId,
    state: "starting",
    protocolVersion: null,
    serverInfo: null,
    connectLatencyMs: null,
    toolCount: null,
    lastError: null,
    updatedAt: now(),
  };
  let tools: McpRawTool[] = [];
  let closing = false;
  const setInfo = (patch: Partial<McpSessionInfo>): void => {
    info = { ...info, ...patch, updatedAt: now() };
    options.onInfo?.(info);
  };

  const client = new Client(CLIENT_INFO, {
    capabilities: {},
    listChanged: {
      tools: {
        autoRefresh: false,
        debounceMs: 300,
        onChanged: () => {
          void refreshTools().catch(() => {});
        },
      },
    },
  });

  const listAllTools = async (): Promise<McpRawTool[]> => {
    const byName = new Map<string, McpRawTool>();
    let cursor: string | undefined;
    for (let page = 0; page < MCP_DEFAULTS.maxPages; page += 1) {
      const result = await client.listTools(cursor ? { cursor } : undefined, { timeout: connectTimeoutMs });
      for (const tool of result.tools) {
        const normalized = normalizeTool(tool);
        if (normalized && !byName.has(normalized.name)) byName.set(normalized.name, normalized);
      }
      cursor = result.nextCursor;
      if (!cursor || byName.size >= MCP_DEFAULTS.maxTools) break;
    }
    return [...byName.values()]
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .slice(0, MCP_DEFAULTS.maxTools);
  };

  const refreshTools = async (): Promise<McpRawTool[]> => {
    if (info.state !== "connected") return tools;
    tools = await listAllTools();
    setInfo({ toolCount: tools.length });
    options.onToolsChanged?.(tools);
    return tools;
  };

  const transport = new VersionRecordingTransport(options.createTransport((chunk) => log.append(chunk)));
  client.onclose = () => {
    if (closing) return;
    setInfo({ state: "error", lastError: "Le serveur s'est arrêté." });
  };
  client.onerror = (error) => {
    // Transport-level noise (bad JSON line, stream error): recorded, the state is decided by close.
    if (!closing && info.state === "connected") setInfo({ lastError: bound(errorMessage(error)) });
  };

  const started = now();
  try {
    await client.connect(transport, { timeout: connectTimeoutMs });
    const version = client.getServerVersion();
    setInfo({ protocolVersion: transport.protocolVersion });
    // A server without the tools capability simply has no tools (not an error).
    tools = client.getServerCapabilities()?.tools ? await listAllTools() : [];
    setInfo({
      state: "connected",
      serverInfo: version ? bound(`${version.name} ${version.version}`.slice(0, 120)) : null,
      connectLatencyMs: now() - started,
      toolCount: tools.length,
      lastError: null,
    });
  } catch (error) {
    const failure = connectFailure(error);
    closing = true;
    await client.close().catch(() => {});
    setInfo({ state: failure.state, lastError: bound(failure.message) });
  }

  return {
    serverId: options.serverId,
    info: () => info,
    tools: () => tools,
    refreshTools,
    stderrTail: (lines) => log.tail(lines),

    async callTool(name, args, callOptions = {}) {
      const start = now();
      const fail = (code: McpCallErrorCode, message: string): McpCallOutcome => ({
        ok: false,
        code,
        message: bound(message),
        durationMs: now() - start,
      });
      if (info.state !== "connected") return fail("unavailable", "Le serveur n'est pas connecté.");
      if (!tools.some((tool) => tool.name === name)) return fail("not_found", `Outil inconnu : ${name}`);
      if (callOptions.signal?.aborted) return fail("cancelled", "Appel annulé.");
      const timeout = callOptions.timeoutMs ?? callTimeoutMs;
      try {
        const result = await client.callTool({ name, arguments: args }, undefined, {
          timeout,
          maxTotalTimeout: timeout,
          ...(callOptions.signal ? { signal: callOptions.signal } : {}),
        });
        const text = renderToolContent(result);
        const truncated = text.length > maxResultChars;
        return {
          ok: true,
          isError: result.isError === true,
          text: truncated ? `${text.slice(0, maxResultChars)}\n[output truncated]` : text,
          truncated,
          durationMs: now() - start,
        };
      } catch (error) {
        if (callOptions.signal?.aborted) return fail("cancelled", "Appel annulé.");
        if (error instanceof McpError) {
          if (error.code === ErrorCode.RequestTimeout) return fail("timeout", "Le serveur n'a pas répondu à temps.");
          if (error.code === ErrorCode.ConnectionClosed || info.state !== "connected") {
            return fail("unavailable", "Le serveur s'est arrêté pendant l'appel.");
          }
          if (error.code === ErrorCode.InvalidParams) return fail("invalid_arguments", error.message);
        }
        if (info.state !== "connected") return fail("unavailable", "Le serveur s'est arrêté pendant l'appel.");
        return fail("failed", errorMessage(error));
      }
    },

    async close() {
      if (closing && info.state !== "connected") return;
      closing = true;
      await client.close().catch(() => {});
      setInfo({ state: "stopped" });
    },
  };
}
