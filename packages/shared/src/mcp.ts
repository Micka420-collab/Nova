// MCP servers and tools (M1/M3/M5). stdio servers run under an mcp-host utilityProcess; Streamable
// HTTP servers are reached from main. Secret env/header values live in the vault (`secrets` table)
// and are only referenced here; descriptions and schemas coming from servers are UNTRUSTED data.
import { z } from "zod";
import { EntityIdSchema } from "./ids";
import type { McpToolName, JsonSchema, JsonSchemaObject } from "./tools";

/** Value of an env variable / HTTP header as stored and returned (never the secret itself). */
export type McpConfigValue =
  | { kind: "plain"; value: string }
  /** Secret kept in the vault; `hint` = last 4 characters, like API keys. */
  | { kind: "secret_ref"; secretRef: string; hint: string };

export type McpTransportConfig =
  | {
      type: "stdio";
      /** Program name or absolute path chosen by the user (npx, uvx, node, docker…). */
      command: string;
      args: string[];
      env: Record<string, McpConfigValue>;
    }
  | { type: "http"; url: string; headers: Record<string, McpConfigValue> };

export type McpScope = "global" | "workspace";

export interface McpServerConfig {
  id: string;
  name: string;
  transport: McpTransportConfig;
  scope: McpScope;
  /** Set exactly when scope is `workspace`. */
  workspaceId: string | null;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export type McpServerState = "disabled" | "stopped" | "starting" | "connected" | "error" | "timeout";

export interface McpServerStatus {
  serverId: string;
  state: McpServerState;
  /** Negotiated protocol version (e.g. `2025-11-25`, `2026-07-28`); null until connected. */
  protocolVersion: string | null;
  toolCount: number | null;
  /** Short, redacted error (never raw stderr). */
  lastError: string | null;
  updatedAt: number;
}

export interface McpServerView {
  config: McpServerConfig;
  status: McpServerStatus;
}

/** Hints only, never proof (M5): a server can lie about being read-only. */
export interface McpToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export type McpToolPermission = "allow" | "ask" | "deny";

export interface McpToolInfo {
  serverId: string;
  name: string;
  /** Name offered to the model; null when it cannot be expressed (too long) — tool not offered. */
  qualifiedName: McpToolName | null;
  /** UNTRUSTED server text; the UI flags imperative instructions found in it. */
  description: string;
  inputSchema: JsonSchemaObject | JsonSchema;
  annotations: McpToolAnnotations;
  /** Effective permission for the requested workspace (tool rule, else default from hints). */
  permission: McpToolPermission;
}

export interface McpTestResult {
  status: McpServerStatus;
  tools: McpToolInfo[];
  /** Last lines of the server's stderr, redacted (stdio only). */
  stderrTail: string;
}

// ---------------------------------------------------------------------------
// Requests

/** Value sent by the renderer: new secrets travel once, to be stored in the vault by main. */
const ConfigValueInputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("plain"), value: z.string().max(4_000) }),
  z.object({ kind: z.literal("secret"), value: z.string().min(1).max(4_000) }),
  z.object({ kind: z.literal("secret_ref"), secretRef: EntityIdSchema }),
]);
export type McpConfigValueInput = z.infer<typeof ConfigValueInputSchema>;

const envName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/, "nom de variable invalide");
const headerName = z.string().regex(/^[A-Za-z0-9-]{1,128}$/, "nom d'en-tête invalide");

const TransportInputSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("stdio"),
    command: z.string().trim().min(1).max(1_000),
    args: z.array(z.string().max(4_000)).max(100),
    env: z.record(envName, ConfigValueInputSchema),
  }),
  z.object({
    type: z.literal("http"),
    url: z.url({ protocol: /^https?$/ }).max(2_000),
    headers: z.record(headerName, ConfigValueInputSchema),
  }),
]);

export const McpServerInputSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    transport: TransportInputSchema,
    scope: z.enum(["global", "workspace"]),
    workspaceId: EntityIdSchema.nullable(),
    enabled: z.boolean(),
  })
  .refine((input) => (input.scope === "workspace") === (input.workspaceId !== null), {
    message: "workspaceId requis exactement pour la portée workspace",
    path: ["workspaceId"],
  });
export type McpServerInput = z.infer<typeof McpServerInputSchema>;

export const McpServerUpdateRequestSchema = z.object({
  serverId: EntityIdSchema,
  name: z.string().trim().min(1).max(100).optional(),
  transport: TransportInputSchema.optional(),
  enabled: z.boolean().optional(),
});
export type McpServerUpdateRequest = z.infer<typeof McpServerUpdateRequestSchema>;

export const McpServerIdRequestSchema = z.object({ serverId: EntityIdSchema });
export type McpServerIdRequest = z.infer<typeof McpServerIdRequestSchema>;

export const McpListRequestSchema = z.object({
  /** null = global servers only; otherwise global + this workspace's servers. */
  workspaceId: EntityIdSchema.nullable(),
});
export type McpListRequest = z.infer<typeof McpListRequestSchema>;

export const McpToolsRequestSchema = z.object({ serverId: EntityIdSchema, workspaceId: EntityIdSchema.nullable() });
export type McpToolsRequest = z.infer<typeof McpToolsRequestSchema>;

export const McpSetToolPermissionRequestSchema = z.object({
  serverId: EntityIdSchema,
  toolName: z.string().min(1).max(200),
  /** null = global rule. */
  workspaceId: EntityIdSchema.nullable(),
  permission: z.enum(["allow", "ask", "deny"]),
});
export type McpSetToolPermissionRequest = z.infer<typeof McpSetToolPermissionRequestSchema>;
