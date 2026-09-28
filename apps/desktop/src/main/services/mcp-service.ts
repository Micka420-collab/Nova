// MCP manager and client broker in main (M1, M3, M5).
//
// - Server configs are stored by @nova/storage (`mcp_servers`); env/header secrets go to the vault
//   (`secrets` table) and the config keeps only `secret_ref` + a hint. A secret value travels once
//   from the renderer (add/update) and is decrypted again only to launch/connect its own server.
// - A config may only reference secrets it already owns (never another server's or the provider
//   key): a `secret_ref` input is accepted only if the server's current config holds it.
// - stdio servers run in the mcp-host utilityProcess (`McpHostPort`); Streamable HTTP servers are
//   connected from main. Both report McpServerStatus; tool lists are cached in `mcp_tools_cache`.
// - Model side (tools lane): `listToolsForModel` offers enabled servers' tools except `deny`;
//   `callTool` re-checks the per-tool rule (deny refused; ask requires the caller's approval) and
//   returns a ToolResult with untrusted `mcp` provenance.
import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { RuntimeLogger } from "@nova/agent-runtime";
import {
  MCP_HOST_EVENTS,
  MCP_HOST_METHODS,
  assignQualifiedNames,
  connectMcpSession,
  effectivePermission,
  flagUntrustedText,
  httpEndpointProblem,
  httpTransportFactory,
  parseProjectMcpJson,
  proposedPermission,
  qualifiedNameOf,
  refusedToolResult,
  toModelDefinition,
  toToolResult,
  type HostConnectParams,
  type HostConnectResult,
  type McpCallOutcome,
  type McpRawTool,
  type McpSession,
  type McpSessionInfo,
  type McpSessionOptions,
  type UntrustedTextFlag,
} from "@nova/mcp";
import {
  McpServerInputSchema,
  McpServerUpdateRequestSchema,
  type JsonSchema,
  type McpConfigValue,
  type McpConfigValueInput,
  type McpImportDraft,
  type McpServerConfig,
  type McpServerInput,
  type McpServerStatus,
  type McpServerView,
  type McpToolAnnotations,
  type McpToolInfo,
  type McpToolName,
  type McpToolPermission,
  type McpTransportConfig,
  type ToolDefinition,
  type ToolResult,
} from "@nova/shared";
import type { NovaStore } from "@nova/storage";
import type { MainApi } from "../api";
import { ServiceError } from "../service-error";
import { VaultError, type SecretVault } from "../vault";
import type { AuditService } from "./audit-service";

/** Subset of @nova/storage's McpRepo (createMcpRepo) used here. */
export interface McpServiceRepo {
  insertServer(input: Omit<McpServerInput, "transport"> & { transport: McpTransportConfig }): McpServerConfig;
  getServer(id: string): McpServerConfig | null;
  findServerByName(workspaceId: string | null, name: string): McpServerConfig | null;
  listServers(workspaceId: string | null): McpServerConfig[];
  updateServer(
    id: string,
    patch: { name?: string; transport?: McpTransportConfig; enabled?: boolean },
  ): McpServerConfig | null;
  deleteServer(id: string): boolean;
  setToolPermission(serverId: string, toolName: string, workspaceId: string | null, permission: McpToolPermission): unknown;
  listToolPermissions(serverId: string): { workspaceId: string | null; toolName: string; permission: McpToolPermission }[];
  replaceCachedTools(
    serverId: string,
    tools: readonly {
      name: string;
      description: string | null;
      inputSchema: JsonSchema;
      annotations: McpToolAnnotations | null;
    }[],
  ): void;
  listCachedTools(
    serverId: string,
  ): { name: string; description: string | null; inputSchema: JsonSchema; annotations: McpToolAnnotations | null }[];
}

/** The mcp-host worker as seen from here (ManagedWorker satisfies it). */
export interface McpHostPort {
  start(): void;
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
  notify(method: string, params?: unknown): void;
  onNotify(listener: (event: { method: string; params: unknown }) => void): () => void;
  /** The host process died on its own; a restarted host holds no session. */
  onExit(listener: () => void): () => void;
}

export interface McpServiceDeps {
  repo: McpServiceRepo;
  /** S5: a tool permission change (e.g. to allow) is a user action in the audit log. */
  audit?: Pick<AuditService, "recordUserAction">;
  secrets: Pick<NovaStore, "putSecret" | "getSecret" | "deleteSecret">;
  vault: SecretVault;
  host: McpHostPort;
  /** Absolute root of a known workspace (cwd of its stdio servers); null when unknown. */
  workspaceRoot(workspaceId: string): string | null;
  /** Streamable HTTP connector (tests inject one); default: the SDK session. */
  connectHttp?: (options: McpSessionOptions) => Promise<McpSession>;
  logger?: RuntimeLogger;
  now?: () => number;
  connectTimeoutMs?: number;
  /** Per-call cap. The mcp-host WorkerSpec.requestTimeoutMs must be larger (see report). */
  callTimeoutMs?: number;
}

/** Tool offered to the model (never a `deny` tool, never a disabled server). */
export interface McpModelTool {
  definition: ToolDefinition & { name: McpToolName };
  serverId: string;
  serverName: string;
  toolName: string;
  permission: Exclude<McpToolPermission, "deny">;
  annotations: McpToolAnnotations;
  /** Heuristic warnings about the (untrusted) description; they never change a decision. */
  descriptionFlags: UntrustedTextFlag[];
}

export interface McpCallContext {
  workspaceId: string;
  callId: string;
  signal: AbortSignal;
  /** The permission engine allowed it, or the user approved the card, for this exact call. */
  approved: boolean;
}

/** A tool as the manager shows it (the UI hints are part of McpToolInfo). */
export type McpToolView = McpToolInfo;

type McpApi = MainApi["mcp"];

const SILENT: RuntimeLogger = { info: () => {}, warn: () => {}, error: () => {} };
/** After a failed automatic connection, wait this long before retrying on the model path. */
const AUTO_RETRY_MS = 60_000;
/** A project `.mcp.json` is a few KB; anything bigger is not read. */
const MCP_JSON_MAX_BYTES = 256 * 1024;
/** Short secrets would be mostly revealed by a 4-character hint. */
const HINT_MIN_LENGTH = 12;

type Resolved = { values: Record<string, string>; secretNames: string[] };

export class McpService {
  private readonly now: () => number;
  private readonly logger: RuntimeLogger;
  private readonly statuses = new Map<string, McpServerStatus>();
  private readonly liveTools = new Map<string, McpRawTool[]>();
  private readonly httpSessions = new Map<string, McpSession>();
  private readonly lastStderr = new Map<string, string>();
  private readonly connecting = new Map<string, Promise<McpServerStatus>>();
  /**
   * Secret values decrypted for a connection this session (tokens, secret env), for the W5
   * anti-exfiltration guard only. Never cleared: a rotated-out secret is still worth catching.
   */
  private readonly decryptedSecrets = new Set<string>();
  private queue: Promise<unknown> = Promise.resolve();
  private readonly unsubscribe: () => void;
  private readonly unsubscribeExit: () => void;

  constructor(private readonly deps: McpServiceDeps) {
    this.now = deps.now ?? Date.now;
    this.logger = deps.logger ?? SILENT;
    this.unsubscribe = deps.host.onNotify((event) => this.onHostEvent(event.method, event.params));
    // No call needs to fail first: every stdio server died with the host, the manager says so now.
    this.unsubscribeExit = deps.host.onExit(() => this.markStdioStopped(() => true));
  }

  /** The `mcp` IPC group (MainApiDeps.atelier.mcp). */
  api(): McpApi {
    return {
      list: async ({ workspaceId }) => this.deps.repo.listServers(workspaceId).map((server) => this.view(server)),
      add: (req) => this.serialize(() => this.add(req)),
      update: (req) => this.serialize(() => this.update(req)),
      remove: (req) => this.serialize(() => this.remove(req.serverId)),
      test: (req) => this.serialize(() => this.test(req.serverId)),
      tools: async ({ serverId, workspaceId }) => this.toolViews(this.requireServer(serverId), workspaceId),
      setToolPermission: async (req) => {
        const server = this.requireServer(req.serverId);
        if (req.workspaceId !== null && server.workspaceId !== null && server.workspaceId !== req.workspaceId) {
          throw new ServiceError("invalid_request", "This server belongs to another workspace");
        }
        if (!this.rawTools(server).some((tool) => tool.name === req.toolName)) {
          throw new ServiceError("not_found", "MCP tool not found");
        }
        this.deps.repo.setToolPermission(server.id, req.toolName, req.workspaceId, req.permission);
        this.deps.audit?.recordUserAction(req.workspaceId, "mcp.tool_permission_changed", `${server.name}/${req.toolName}`, {
          serverId: server.id,
          permission: req.permission,
        });
        this.logger.info("mcp tool permission set", { serverId: server.id, permission: req.permission });
        const view = this.toolViews(server, req.workspaceId).find((tool) => tool.name === req.toolName);
        if (!view) throw new ServiceError("not_found", "MCP tool not found");
        return view;
      },
      logs: ({ serverId }) => this.stderrTail(serverId),
      importProject: async ({ workspaceId }) => this.importProject(workspaceId),
    };
  }

  /** M3: drafts from `<workspace>/.mcp.json`; nothing is saved (variables are never expanded). */
  private async importProject(workspaceId: string): Promise<McpImportDraft[]> {
    const root = this.deps.workspaceRoot(workspaceId);
    if (!root) throw new ServiceError("not_found", "Workspace not found");
    let text: string;
    try {
      const file = join(root, ".mcp.json");
      if ((await stat(file)).size > MCP_JSON_MAX_BYTES) throw new ServiceError("invalid_request", ".mcp.json is too large");
      text = await readFile(file, "utf8");
    } catch (error) {
      if (error instanceof ServiceError) throw error;
      throw new ServiceError("not_found", "No .mcp.json in this workspace");
    }
    try {
      return parseProjectMcpJson(text, { scope: "workspace", workspaceId });
    } catch {
      throw new ServiceError("invalid_request", ".mcp.json is not a valid MCP configuration");
    }
  }

  /** Redacted stderr tail of a stdio server (live, or from its last run). */
  async stderrTail(serverId: string, lines = 50): Promise<string> {
    const server = this.requireServer(serverId);
    if (server.transport.type !== "stdio") return "";
    try {
      return await this.deps.host.request<string>(MCP_HOST_METHODS.stderr, { serverId, lines });
    } catch {
      return this.lastStderr.get(serverId) ?? "";
    }
  }

  // -------------------------------------------------------------------------------------------
  // Model side

  async listToolsForModel(workspaceId: string, options: { connect?: boolean } = {}): Promise<McpModelTool[]> {
    const servers = this.deps.repo.listServers(workspaceId).filter((server) => server.enabled);
    if (options.connect !== false) {
      await this.reconcileHost();
      await Promise.all(servers.map((server) => this.ensureConnected(server)));
    }
    const live = servers.filter((server) => this.statuses.get(server.id)?.state === "connected");
    const entries = live.flatMap((server) =>
      (this.liveTools.get(server.id) ?? []).map((tool) => ({ server, tool })),
    );
    const names = assignQualifiedNames(
      entries.map(({ server, tool }) => ({ serverId: server.id, serverName: server.name, toolName: tool.name })),
    );
    const rulesByServer = new Map(live.map((server) => [server.id, this.deps.repo.listToolPermissions(server.id)]));
    const result: McpModelTool[] = [];
    for (const { server, tool } of entries) {
      const name = qualifiedNameOf(names, server.id, tool.name);
      if (!name) continue;
      const rules = (rulesByServer.get(server.id) ?? []).filter((rule) => rule.toolName === tool.name);
      const permission = effectivePermission(rules, workspaceId);
      if (permission === "deny") continue;
      result.push({
        definition: {
          ...toModelDefinition(name, {
            serverName: server.name,
            transport: server.transport.type,
            toolName: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
            annotations: tool.annotations,
          }),
          name,
        },
        serverId: server.id,
        serverName: server.name,
        toolName: tool.name,
        permission,
        annotations: tool.annotations,
        descriptionFlags: flagUntrustedText(tool.description),
      });
    }
    return result.sort((a, b) => (a.definition.name < b.definition.name ? -1 : 1));
  }

  /** Literal MCP secrets in use this session (compared by the web guard, never logged). */
  knownSecrets(): string[] {
    return [...this.decryptedSecrets];
  }

  /**
   * Resolved by server id and tool name, as offered and approved: the qualified name may now map
   * to another server (same name, other scope) that connected since the mission started.
   */
  async callTool(
    target: { serverId: string; toolName: string },
    args: Record<string, unknown>,
    context: McpCallContext,
  ): Promise<ToolResult> {
    const tool = (await this.listToolsForModel(context.workspaceId, { connect: false })).find(
      (candidate) => candidate.serverId === target.serverId && candidate.toolName === target.toolName,
    );
    if (!tool) {
      // Unknown, denied, disabled or disconnected: never executed.
      const ref = `${this.deps.repo.getServer(target.serverId)?.name ?? "?"}/${target.toolName}`;
      return refusedToolResult(context.callId, "not_found", `MCP tool ${ref} is not available.`, ref);
    }
    const ref = `${tool.serverName}/${tool.toolName}`;
    if (tool.permission === "ask" && !context.approved) {
      return refusedToolResult(context.callId, "permission_denied", `MCP tool ${ref} requires the user's approval.`, ref);
    }
    const server = this.deps.repo.getServer(tool.serverId);
    if (!server?.enabled) return refusedToolResult(context.callId, "unavailable", `MCP server of ${ref} is disabled.`, ref);
    const outcome = await this.invoke(server, tool.toolName, args, context);
    this.logger.info("mcp tool called", { serverId: server.id, ok: outcome.ok, durationMs: outcome.durationMs });
    return toToolResult(outcome, { callId: context.callId, serverName: server.name, toolName: tool.toolName });
  }

  /** Closes HTTP sessions and stdio servers (app shutdown). */
  async shutdown(): Promise<void> {
    this.unsubscribe();
    this.unsubscribeExit();
    await Promise.all([...this.httpSessions.values()].map((session) => session.close()));
    this.httpSessions.clear();
    const stdio = [...this.statuses.values()].filter((status) => status.state === "connected");
    await Promise.all(
      stdio.map((status) =>
        this.deps.host.request(MCP_HOST_METHODS.close, { serverId: status.serverId }).catch(() => {}),
      ),
    );
  }

  // -------------------------------------------------------------------------------------------
  // Manager

  private async add(raw: McpServerInput): Promise<McpServerView> {
    const input = this.parse(McpServerInputSchema, raw);
    if (input.workspaceId !== null && this.deps.workspaceRoot(input.workspaceId) === null) {
      throw new ServiceError("not_found", "Workspace not found");
    }
    if (this.deps.repo.findServerByName(input.workspaceId, input.name)) {
      throw new ServiceError("conflict", "An MCP server with this name already exists");
    }
    const { transport, created } = await this.storeTransport(input.transport, new Map());
    try {
      const server = this.deps.repo.insertServer({ ...input, transport });
      this.logger.info("mcp server added", { serverId: server.id, transport: transport.type, scope: server.scope });
      return this.view(server);
    } catch (error) {
      for (const id of created) this.deps.secrets.deleteSecret(id);
      throw error;
    }
  }

  private async update(raw: McpApiUpdate): Promise<McpServerView> {
    const req = this.parse(McpServerUpdateRequestSchema, raw);
    const current = this.requireServer(req.serverId);
    if (req.name !== undefined && req.name !== current.name) {
      const taken = this.deps.repo.findServerByName(current.workspaceId, req.name);
      if (taken && taken.id !== current.id) throw new ServiceError("conflict", "An MCP server with this name already exists");
    }
    let transport: McpTransportConfig | undefined;
    let created: string[] = [];
    if (req.transport) {
      ({ transport, created } = await this.storeTransport(req.transport, secretRefs(current.transport)));
    }
    let updated: McpServerConfig | null;
    try {
      updated = this.deps.repo.updateServer(current.id, {
        ...(req.name !== undefined ? { name: req.name } : {}),
        ...(transport ? { transport } : {}),
        ...(req.enabled !== undefined ? { enabled: req.enabled } : {}),
      });
    } catch (error) {
      for (const id of created) this.deps.secrets.deleteSecret(id);
      throw error;
    }
    if (!updated) throw new ServiceError("not_found", "MCP server not found");
    const kept = secretRefs(updated.transport);
    for (const id of secretRefs(current.transport).keys()) if (!kept.has(id)) this.deps.secrets.deleteSecret(id);
    if (transport || !updated.enabled) await this.disconnect(updated, updated.enabled ? "stopped" : "disabled");
    this.logger.info("mcp server updated", { serverId: updated.id, enabled: updated.enabled });
    return this.view(updated);
  }

  private async remove(serverId: string): Promise<void> {
    const server = this.requireServer(serverId);
    await this.disconnect(server, "stopped");
    this.deps.repo.deleteServer(server.id);
    for (const id of secretRefs(server.transport).keys()) this.deps.secrets.deleteSecret(id);
    this.statuses.delete(server.id);
    this.liveTools.delete(server.id);
    this.lastStderr.delete(server.id);
    this.logger.info("mcp server removed", { serverId: server.id });
  }

  /** Explicit user test: (re)connects even a disabled server, then reports status, tools, stderr. */
  private async test(serverId: string) {
    const server = this.requireServer(serverId);
    await this.disconnect(server, "stopped");
    const status = await this.connect(server, true);
    const tools = this.toolViews(server, server.workspaceId);
    const stderrTail = await this.stderrTail(server.id).catch(() => "");
    if (!server.enabled) await this.disconnect(server, "disabled");
    return { status, tools, stderrTail };
  }

  // -------------------------------------------------------------------------------------------
  // Connections

  private ensureConnected(server: McpServerConfig): Promise<McpServerStatus> {
    const status = this.statuses.get(server.id);
    if (status?.state === "connected") return Promise.resolve(status);
    const failedRecently =
      (status?.state === "error" || status?.state === "timeout") && this.now() - status.updatedAt < AUTO_RETRY_MS;
    if (failedRecently && status) return Promise.resolve(status);
    return this.connect(server);
  }

  /** `explicit`: the user's test, which connects even a disabled server. */
  private connect(server: McpServerConfig, explicit = false): Promise<McpServerStatus> {
    const pending = this.connecting.get(server.id);
    if (pending) return pending;
    const attempt = this.connectOnce(server, explicit).finally(() => this.connecting.delete(server.id));
    this.connecting.set(server.id, attempt);
    return attempt;
  }

  /**
   * The config this attempt launched is no longer the stored, wanted one: the server was removed,
   * disabled or reconfigured (e.g. a leaked token replaced) while it was starting.
   */
  private superseded(server: McpServerConfig, explicit: boolean): boolean {
    const current = this.deps.repo.getServer(server.id);
    if (!current || (!current.enabled && !explicit)) return true;
    return JSON.stringify(current.transport) !== JSON.stringify(server.transport);
  }

  /** Status of a server whose fresh connection was just closed as superseded. */
  private dropSuperseded(serverId: string): McpServerStatus {
    this.liveTools.delete(serverId);
    const current = this.deps.repo.getServer(serverId);
    if (!current) this.statuses.delete(serverId);
    const reset = { state: current?.enabled === false ? "disabled" : "stopped", protocolVersion: null, toolCount: null, lastError: null } as const;
    return current ? this.setStatus(serverId, reset) : { serverId, ...reset, updatedAt: this.now() };
  }

  private async connectOnce(server: McpServerConfig, explicit: boolean): Promise<McpServerStatus> {
    this.setStatus(server.id, { state: "starting", protocolVersion: null, toolCount: null, lastError: null });
    let resolved: { env: Resolved; headers: Resolved };
    try {
      resolved = {
        env: await this.resolveValues(server.transport.type === "stdio" ? server.transport.env : {}),
        headers: await this.resolveValues(server.transport.type === "http" ? server.transport.headers : {}),
      };
    } catch {
      return this.setStatus(server.id, { state: "error", lastError: "Un secret de ce serveur est illisible (coffre)." });
    }

    if (server.transport.type === "stdio") {
      const params: HostConnectParams = {
        serverId: server.id,
        launch: {
          command: server.transport.command,
          args: server.transport.args,
          env: resolved.env.values,
          cwd: server.workspaceId ? this.deps.workspaceRoot(server.workspaceId) : null,
        },
        secretEnvNames: resolved.env.secretNames,
        connectTimeoutMs: this.deps.connectTimeoutMs ?? null,
        callTimeoutMs: this.deps.callTimeoutMs ?? null,
      };
      try {
        this.deps.host.start();
        const result = await this.deps.host.request<HostConnectResult>(MCP_HOST_METHODS.connect, params);
        if (this.superseded(server, explicit)) {
          // Never keep a process running with an old (or removed) config and its secrets.
          await this.deps.host.request(MCP_HOST_METHODS.close, { serverId: server.id }).catch(() => {});
          return this.dropSuperseded(server.id);
        }
        this.lastStderr.set(server.id, result.stderrTail);
        if (result.info.state === "connected") this.acceptTools(server.id, result.tools);
        return this.applyInfo(result.info);
      } catch {
        return this.setStatus(server.id, { state: "error", lastError: "Le processus hôte MCP ne répond pas." });
      }
    }

    const problem = httpEndpointProblem(server.transport.url, resolved.headers.secretNames.length > 0);
    if (problem) return this.setStatus(server.id, { state: "error", lastError: problem });
    const connect = this.deps.connectHttp ?? connectMcpSession;
    // Events of a session that is not (or no longer) the registered one are ignored.
    let session: McpSession | null = null;
    session = await connect({
      serverId: server.id,
      createTransport: httpTransportFactory({ url: server.transport.url, headers: resolved.headers.values }),
      secretValues: resolved.headers.secretNames.map((name) => resolved.headers.values[name] ?? ""),
      ...(this.deps.connectTimeoutMs ? { connectTimeoutMs: this.deps.connectTimeoutMs } : {}),
      ...(this.deps.callTimeoutMs ? { callTimeoutMs: this.deps.callTimeoutMs } : {}),
      onInfo: (info) => {
        if (this.httpSessions.get(server.id) === session) this.applyInfo(info);
      },
      onToolsChanged: (tools) => {
        if (this.httpSessions.get(server.id) === session) this.acceptTools(server.id, tools);
      },
    });
    if (this.superseded(server, explicit)) {
      await session.close();
      return this.dropSuperseded(server.id);
    }
    if (session.info().state === "connected") {
      this.httpSessions.set(server.id, session);
      this.acceptTools(server.id, session.tools());
    }
    return this.applyInfo(session.info());
  }

  private async disconnect(server: McpServerConfig, state: "stopped" | "disabled"): Promise<void> {
    // A connection still starting would register itself after this close: let it land first.
    await this.connecting.get(server.id)?.catch(() => undefined);
    const session = this.httpSessions.get(server.id);
    this.httpSessions.delete(server.id);
    if (session) await session.close();
    if (server.transport.type === "stdio" && this.statuses.get(server.id)?.state === "connected") {
      this.lastStderr.set(server.id, await this.stderrTail(server.id).catch(() => ""));
      await this.deps.host.request(MCP_HOST_METHODS.close, { serverId: server.id }).catch(() => {});
    }
    this.liveTools.delete(server.id);
    this.setStatus(server.id, { state, lastError: null });
  }

  private async invoke(
    server: McpServerConfig,
    toolName: string,
    args: Record<string, unknown>,
    context: McpCallContext,
  ): Promise<McpCallOutcome> {
    if (server.transport.type === "http") {
      const session = this.httpSessions.get(server.id);
      if (!session) return { ok: false, code: "unavailable", message: "Le serveur n'est pas connecté.", durationMs: 0 };
      return session.callTool(toolName, args, { signal: context.signal });
    }
    const cancel = (): void => this.deps.host.notify(MCP_HOST_METHODS.cancel, { callId: context.callId });
    context.signal.addEventListener("abort", cancel, { once: true });
    try {
      return await this.deps.host.request<McpCallOutcome>(MCP_HOST_METHODS.callTool, {
        serverId: server.id,
        callId: context.callId,
        name: toolName,
        args,
        timeoutMs: this.deps.callTimeoutMs ?? null,
      });
    } catch {
      this.setStatus(server.id, { state: "error", lastError: "Le processus hôte MCP s'est arrêté." });
      return { ok: false, code: "unavailable", message: "Le processus hôte MCP s'est arrêté.", durationMs: 0 };
    } finally {
      context.signal.removeEventListener("abort", cancel);
    }
  }

  /** The host restarts after a crash with no session: stdio servers believed connected are not. */
  private async reconcileHost(): Promise<void> {
    const believed = [...this.statuses.values()].filter(
      (status) => status.state === "connected" && !this.httpSessions.has(status.serverId),
    );
    if (believed.length === 0) return;
    let live: McpSessionInfo[];
    try {
      live = await this.deps.host.request<McpSessionInfo[]>(MCP_HOST_METHODS.sessions);
    } catch {
      live = [];
    }
    const alive = new Set(live.filter((info) => info.state === "connected").map((info) => info.serverId));
    const checked = new Set(believed.map((status) => status.serverId));
    this.markStdioStopped((serverId) => checked.has(serverId) && !alive.has(serverId));
  }

  /** stdio servers believed connected that `lost` says are gone become stopped, without tools. */
  private markStdioStopped(lost: (serverId: string) => boolean): void {
    for (const status of [...this.statuses.values()]) {
      if (status.state !== "connected" || this.httpSessions.has(status.serverId) || !lost(status.serverId)) continue;
      this.liveTools.delete(status.serverId);
      this.setStatus(status.serverId, { state: "stopped", lastError: null });
    }
  }

  private onHostEvent(method: string, params: unknown): void {
    if (typeof params !== "object" || params === null) return;
    if (method === MCP_HOST_EVENTS.info) {
      const info = params as McpSessionInfo;
      if (this.statuses.has(info.serverId) && !this.connecting.has(info.serverId)) {
        if (info.state !== "connected") this.liveTools.delete(info.serverId);
        this.applyInfo(info);
      }
    } else if (method === MCP_HOST_EVENTS.tools) {
      const { serverId, tools } = params as { serverId: string; tools: McpRawTool[] };
      if (this.statuses.get(serverId)?.state === "connected") this.acceptTools(serverId, tools);
    }
  }

  private acceptTools(serverId: string, tools: McpRawTool[]): void {
    this.liveTools.set(serverId, tools);
    try {
      this.deps.repo.replaceCachedTools(
        serverId,
        tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          annotations: tool.annotations,
        })),
      );
    } catch (error) {
      // The server may have been removed meanwhile (FK): the live list stays in memory only.
      this.logger.warn("mcp tools cache not updated", { serverId, error: String(error) });
    }
  }

  private applyInfo(info: McpSessionInfo): McpServerStatus {
    return this.setStatus(info.serverId, {
      state: info.state,
      protocolVersion: info.protocolVersion,
      toolCount: info.toolCount,
      lastError: info.lastError,
    });
  }

  private setStatus(serverId: string, patch: Partial<Omit<McpServerStatus, "serverId" | "updatedAt">>): McpServerStatus {
    const previous = this.statuses.get(serverId);
    const status: McpServerStatus = {
      serverId,
      state: patch.state ?? previous?.state ?? "stopped",
      protocolVersion: patch.protocolVersion !== undefined ? patch.protocolVersion : (previous?.protocolVersion ?? null),
      toolCount: patch.toolCount !== undefined ? patch.toolCount : (previous?.toolCount ?? null),
      lastError: patch.lastError !== undefined ? patch.lastError : (previous?.lastError ?? null),
      updatedAt: this.now(),
    };
    this.statuses.set(serverId, status);
    return status;
  }

  // -------------------------------------------------------------------------------------------
  // Views

  private view(server: McpServerConfig): McpServerView {
    const status = this.statuses.get(server.id) ?? {
      serverId: server.id,
      state: "stopped",
      protocolVersion: null,
      toolCount: null,
      lastError: null,
      updatedAt: server.updatedAt,
    };
    // `enabled` is the stored truth; a live state (connected, error…) is shown as observed.
    let state = status.state;
    if (!server.enabled && state === "stopped") state = "disabled";
    if (server.enabled && state === "disabled") state = "stopped";
    return { config: server, status: { ...status, state } };
  }

  /** Live tools when connected, else the cached list (so a stopped server still shows its tools). */
  private rawTools(server: McpServerConfig): McpRawTool[] {
    const live = this.liveTools.get(server.id);
    if (live) return live;
    return this.deps.repo.listCachedTools(server.id).map((tool) => ({
      name: tool.name,
      description: tool.description ?? "",
      inputSchema: tool.inputSchema,
      annotations: tool.annotations ?? {},
    }));
  }

  private toolViews(server: McpServerConfig, workspaceId: string | null): McpToolView[] {
    const visible = this.deps.repo.listServers(workspaceId ?? server.workspaceId);
    const peers = visible.some((peer) => peer.id === server.id) ? visible : [...visible, server];
    const names = assignQualifiedNames(
      peers.flatMap((peer) =>
        this.rawTools(peer).map((tool) => ({ serverId: peer.id, serverName: peer.name, toolName: tool.name })),
      ),
    );
    const rules = this.deps.repo.listToolPermissions(server.id);
    return this.rawTools(server).map((tool) => ({
      serverId: server.id,
      name: tool.name,
      qualifiedName: qualifiedNameOf(names, server.id, tool.name),
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: tool.annotations,
      permission: effectivePermission(
        rules.filter((rule) => rule.toolName === tool.name),
        workspaceId,
      ),
      descriptionFlags: flagUntrustedText(tool.description),
      proposedPermission: proposedPermission(tool.annotations),
    }));
  }

  // -------------------------------------------------------------------------------------------
  // Secrets

  /**
   * Converts transport input to stored config: new secret values are encrypted into the vault
   * (strict: OS-level protection required), existing references must belong to this server.
   */
  private async storeTransport(
    input: McpServerInput["transport"],
    owned: ReadonlyMap<string, string>,
  ): Promise<{ transport: McpTransportConfig; created: string[] }> {
    const created: string[] = [];
    const store = async (values: Record<string, McpConfigValueInput>): Promise<Record<string, McpConfigValue>> => {
      const out: Record<string, McpConfigValue> = {};
      for (const [name, value] of Object.entries(values)) {
        if (value.kind === "plain") out[name] = { kind: "plain", value: value.value };
        else if (value.kind === "secret_ref") {
          const hint = owned.get(value.secretRef);
          if (hint === undefined) throw new ServiceError("invalid_request", "Unknown secret reference");
          out[name] = { kind: "secret_ref", secretRef: value.secretRef, hint };
        } else {
          const status = await this.deps.vault.status();
          const ciphertext = await this.deps.vault.encrypt(value.value);
          const id = randomUUID();
          this.deps.secrets.putSecret({ id, ciphertext, backend: status.backend, createdAt: this.now() });
          created.push(id);
          const hint = value.value.length >= HINT_MIN_LENGTH ? value.value.slice(-4) : "";
          out[name] = { kind: "secret_ref", secretRef: id, hint };
        }
      }
      return out;
    };
    try {
      const transport: McpTransportConfig =
        input.type === "stdio"
          ? { type: "stdio", command: input.command, args: input.args, env: await store(input.env) }
          : { type: "http", url: input.url, headers: await store(input.headers) };
      if (transport.type === "http") {
        const carriesSecrets = Object.values(transport.headers).some((value) => value.kind === "secret_ref");
        const problem = httpEndpointProblem(transport.url, carriesSecrets);
        if (problem) throw new ServiceError("invalid_request", problem);
      }
      return { transport, created };
    } catch (error) {
      for (const id of created) this.deps.secrets.deleteSecret(id);
      throw error;
    }
  }

  private async resolveValues(values: Record<string, McpConfigValue>): Promise<Resolved> {
    const resolved: Resolved = { values: {}, secretNames: [] };
    for (const [name, value] of Object.entries(values)) {
      if (value.kind === "plain") {
        resolved.values[name] = value.value;
        continue;
      }
      const secret = this.deps.secrets.getSecret(value.secretRef);
      if (!secret) throw new VaultError("Missing secret");
      const plain = (await this.deps.vault.decrypt(secret.ciphertext)).plain;
      resolved.values[name] = plain;
      resolved.secretNames.push(name);
      this.decryptedSecrets.add(plain);
    }
    return resolved;
  }

  // -------------------------------------------------------------------------------------------

  private requireServer(serverId: string): McpServerConfig {
    const server = this.deps.repo.getServer(serverId);
    if (!server) throw new ServiceError("not_found", "MCP server not found");
    return server;
  }

  private parse<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, value: unknown): T {
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new ServiceError("invalid_request", "Invalid MCP server request");
    return parsed.data;
  }

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => {});
    return run;
  }
}

type McpApiUpdate = Parameters<McpApi["update"]>[0];

/** Secret references held by a config, with their hints. */
function secretRefs(transport: McpTransportConfig): Map<string, string> {
  const values = transport.type === "stdio" ? transport.env : transport.headers;
  const refs = new Map<string, string>();
  for (const value of Object.values(values)) if (value.kind === "secret_ref") refs.set(value.secretRef, value.hint);
  return refs;
}
