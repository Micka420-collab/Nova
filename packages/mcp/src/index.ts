// @nova/mcp — MCP client (M1/M3/M4/M5) on @modelcontextprotocol/sdk (never a hand-written protocol).
//
// - stdio servers run as children of the `mcp-host` utilityProcess (`McpStdioHost`): scrubbed env
//   (the host's own env is already scrubbed by main; the SDK only inherits HOME/PATH/…), secret
//   values injected by main for that spawn only, stderr in a redacted ring buffer.
// - Streamable HTTP servers are reached from main (`connectMcpSession` + `httpTransportFactory`).
//   The legacy HTTP+SSE transport is not supported. No OAuth in J2-A.
// - SDK 1.30.1 negotiates up to protocol 2025-11-25 (initialize handshake). Servers that ONLY
//   speak 2026-07-28 (no initialize) are not reachable until the SDK v2 lands (FEATURES §2d).
// - Tool lists are sorted by name, bounded, refreshed on `tools/list_changed`; descriptions and
//   schemas are UNTRUSTED (`flagUntrustedText` flags imperative text; it never grants anything).
// - Default permission `ask`; `readOnlyHint` only PROPOSES `allow`; tools without hints (spec
//   defaults: destructive, open-world) are operation `external`. Deny = never offered nor run.
// - Timeouts and output caps per call; a crashed server becomes state `error`, never a hang.
export { MCP_CATALOG, catalogServerInput, type McpCatalogEntry, type McpCatalogInput, type McpCatalogTransport } from "./catalog";
export {
  HostParamsError,
  MCP_HOST_EVENTS,
  MCP_HOST_METHODS,
  McpStdioHost,
  createHostHandlers,
  parseCallId,
  parseCallParams,
  parseConnectParams,
  parseServerId,
  type HostCallParams,
  type HostConnectParams,
  type HostConnectResult,
} from "./host";
export { parseProjectMcpJson, type McpImportDraft, type McpImportWarning } from "./import-config";
export { assignQualifiedNames, qualifiedNameOf, type NamingEntry } from "./naming";
export { effectivePermission, mcpOperation, proposedPermission, type McpPermissionRule } from "./policy";
export {
  MCP_DEFAULTS,
  connectMcpSession,
  renderToolContent,
  type McpCallErrorCode,
  type McpCallOptions,
  type McpCallOutcome,
  type McpRawTool,
  type McpSession,
  type McpSessionInfo,
  type McpSessionOptions,
} from "./session";
export { StderrLog } from "./stderr-log";
export { refusedToolResult, toModelDefinition, toObjectSchema, toToolResult, type ModelToolSource } from "./tool-view";
export { httpEndpointProblem, httpTransportFactory, stdioTransportFactory, type HttpEndpoint, type StdioLaunch } from "./transports";
export { flagUntrustedText, type UntrustedTextFlag } from "./untrusted";
