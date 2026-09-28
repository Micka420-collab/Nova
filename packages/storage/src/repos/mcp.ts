// MCP servers (M1/M3), per-tool permissions (M5) and the tools cache (migration v4).
// `config_json` stores the McpTransportConfig as-is: env/header values are either plain text or
// `secret_ref` pointers to the `secrets` table (with a 4-character hint), never secret values.
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  JsonSchema,
  McpScope,
  McpServerConfig,
  McpToolAnnotations,
  McpToolPermission,
  McpTransportConfig,
} from "@nova/shared";
import { readJsonOrNull, readNumber, readText, readTextOrNull, withTransaction, type Row } from "../sqlite";

export interface NewMcpServer {
  name: string;
  transport: McpTransportConfig;
  scope: McpScope;
  workspaceId: string | null;
  enabled: boolean;
}

export interface McpServerPatch {
  name?: string;
  transport?: McpTransportConfig;
  enabled?: boolean;
}

export interface McpToolPermissionRecord {
  serverId: string;
  toolName: string;
  /** null = rule for every workspace. */
  workspaceId: string | null;
  permission: McpToolPermission;
  updatedAt: number;
}

/** Last tool list seen from a server (untrusted server data, shown while it is stopped). */
export interface McpCachedTool {
  name: string;
  description: string | null;
  inputSchema: JsonSchema;
  annotations: McpToolAnnotations | null;
  fetchedAt: number;
}

export interface McpRepo {
  insertServer(input: NewMcpServer): McpServerConfig;
  getServer(id: string): McpServerConfig | null;
  /** Server with this exact name in the same scope (global when workspaceId is null). */
  findServerByName(workspaceId: string | null, name: string): McpServerConfig | null;
  /** Global servers, plus the workspace's own when `workspaceId` is set; sorted by name then id. */
  listServers(workspaceId: string | null): McpServerConfig[];
  updateServer(id: string, patch: McpServerPatch): McpServerConfig | null;
  deleteServer(id: string): boolean;
  setToolPermission(
    serverId: string,
    toolName: string,
    workspaceId: string | null,
    permission: McpToolPermission,
  ): McpToolPermissionRecord;
  listToolPermissions(serverId: string): McpToolPermissionRecord[];
  /** Replaces the whole cached list of a server (one transaction). */
  replaceCachedTools(serverId: string, tools: readonly Omit<McpCachedTool, "fetchedAt">[]): void;
  /** Cached tools sorted by name. */
  listCachedTools(serverId: string): McpCachedTool[];
}

function toServer(row: Row): McpServerConfig {
  const transport = readJsonOrNull<McpTransportConfig>(row, "config_json");
  if (!transport) throw new Error("mcp_servers.config_json is null");
  return {
    id: readText(row, "id"),
    name: readText(row, "name"),
    transport,
    // Enum columns are guarded by CHECK constraints.
    scope: readText(row, "scope") as McpScope,
    workspaceId: readTextOrNull(row, "workspace_id"),
    enabled: readNumber(row, "enabled") === 1,
    createdAt: readNumber(row, "created_at"),
    updatedAt: readNumber(row, "updated_at"),
  };
}

function toPermission(row: Row): McpToolPermissionRecord {
  return {
    serverId: readText(row, "server_id"),
    toolName: readText(row, "tool_name"),
    workspaceId: readTextOrNull(row, "workspace_id"),
    permission: readText(row, "permission") as McpToolPermission,
    updatedAt: readNumber(row, "updated_at"),
  };
}

function toCachedTool(row: Row): McpCachedTool {
  return {
    name: readText(row, "name"),
    description: readTextOrNull(row, "description"),
    inputSchema: readJsonOrNull<JsonSchema>(row, "input_schema_json") ?? { type: "object" },
    annotations: readJsonOrNull<McpToolAnnotations>(row, "annotations_json"),
    fetchedAt: readNumber(row, "fetched_at"),
  };
}

export function createMcpRepo(db: DatabaseSync, now: () => number = Date.now): McpRepo {
  const getServer = (id: string): McpServerConfig | null => {
    const row = db.prepare("SELECT * FROM mcp_servers WHERE id = ?").get(id);
    return row ? toServer(row) : null;
  };

  return {
    insertServer(input) {
      const at = now();
      const row = db
        .prepare(
          `INSERT INTO mcp_servers
             (id, name, workspace_id, scope, transport, config_json, enabled, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
        )
        .get(
          randomUUID(),
          input.name,
          input.workspaceId,
          input.scope,
          input.transport.type,
          JSON.stringify(input.transport),
          input.enabled ? 1 : 0,
          at,
          at,
        );
      if (!row) throw new Error("MCP server insert returned no row");
      return toServer(row);
    },

    getServer,

    findServerByName(workspaceId, name) {
      const row = db
        .prepare("SELECT * FROM mcp_servers WHERE coalesce(workspace_id, '') = ? AND name = ?")
        .get(workspaceId ?? "", name);
      return row ? toServer(row) : null;
    },

    listServers(workspaceId) {
      const rows =
        workspaceId === null
          ? db.prepare("SELECT * FROM mcp_servers WHERE workspace_id IS NULL ORDER BY name, id").all()
          : db
              .prepare("SELECT * FROM mcp_servers WHERE workspace_id IS NULL OR workspace_id = ? ORDER BY name, id")
              .all(workspaceId);
      return rows.map(toServer);
    },

    updateServer(id, patch) {
      const current = getServer(id);
      if (!current) return null;
      const transport = patch.transport ?? current.transport;
      const row = db
        .prepare(
          `UPDATE mcp_servers SET name = ?, transport = ?, config_json = ?, enabled = ?, updated_at = ?
           WHERE id = ? RETURNING *`,
        )
        .get(
          patch.name ?? current.name,
          transport.type,
          JSON.stringify(transport),
          (patch.enabled ?? current.enabled) ? 1 : 0,
          now(),
          id,
        );
      return row ? toServer(row) : null;
    },

    deleteServer(id) {
      return Number(db.prepare("DELETE FROM mcp_servers WHERE id = ?").run(id).changes) > 0;
    },

    setToolPermission(serverId, toolName, workspaceId, permission) {
      const row = db
        .prepare(
          `INSERT INTO mcp_tool_permissions (server_id, tool_name, workspace_id, permission, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (server_id, tool_name, coalesce(workspace_id, ''))
           DO UPDATE SET permission = excluded.permission, updated_at = excluded.updated_at
           RETURNING *`,
        )
        .get(serverId, toolName, workspaceId, permission, now());
      if (!row) throw new Error("MCP tool permission upsert returned no row");
      return toPermission(row);
    },

    listToolPermissions(serverId) {
      return db
        .prepare("SELECT * FROM mcp_tool_permissions WHERE server_id = ? ORDER BY tool_name, workspace_id")
        .all(serverId)
        .map(toPermission);
    },

    replaceCachedTools(serverId, tools) {
      const at = now();
      withTransaction(db, () => {
        db.prepare("DELETE FROM mcp_tools_cache WHERE server_id = ?").run(serverId);
        const insert = db.prepare(
          `INSERT INTO mcp_tools_cache (server_id, name, description, input_schema_json, annotations_json, fetched_at)
           VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (server_id, name) DO NOTHING`,
        );
        for (const tool of tools) {
          insert.run(
            serverId,
            tool.name,
            tool.description,
            JSON.stringify(tool.inputSchema),
            tool.annotations ? JSON.stringify(tool.annotations) : null,
            at,
          );
        }
      });
    },

    listCachedTools(serverId) {
      return db
        .prepare("SELECT * FROM mcp_tools_cache WHERE server_id = ? ORDER BY name")
        .all(serverId)
        .map(toCachedTool);
    },
  };
}
