// @nova/mcp — MCP client (M1/M3/M5) on @modelcontextprotocol/sdk (never a hand-written protocol).
//
// Contract for the feature implementation:
// - stdio servers run as children of an `mcp-host` utilityProcess (scrubbed env; secret env values
//   injected from the vault by main, by reference only). Streamable HTTP servers are reached from
//   main. The legacy HTTP+SSE transport is not supported. No OAuth in J2-A.
// - Tool lists are sorted by name (stable prompt), cached (`mcp_tools_cache`) and refreshed on
//   `listChanged`; descriptions/schemas are UNTRUSTED (flag imperative text; never grant anything).
// - Default permission: `ask`; `readOnlyHint` proposes `allow` (confirmed once); `destructiveHint`
//   or `openWorldHint` = operation `external` (never rememberable). Disabled tools are never sent
//   to the model nor executed.
// - Timeouts and output caps per call; a crashed server becomes status `error`, never a hang.
import type { McpServerConfig, McpServerStatus, McpToolInfo, ToolResult } from "@nova/shared";

/** Secret values resolved by main right before connecting; never persisted by this package. */
export type ResolvedSecrets = Readonly<Record<string, string>>;

export interface McpConnection {
  readonly serverId: string;
  status(): McpServerStatus;
  listTools(): Promise<McpToolInfo[]>;
  callTool(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<ToolResult>;
  close(): Promise<void>;
}

export interface McpClientFactory {
  connect(config: McpServerConfig, secrets: ResolvedSecrets, signal: AbortSignal): Promise<McpConnection>;
}
