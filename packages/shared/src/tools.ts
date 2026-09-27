// Agent tool contract (J2-A): names, definitions sent to the model, calls and results.
// Executors live in @nova/tools (worker side); the permission engine (@nova/permissions, main)
// decides on every call BEFORE execution using `operation` + the call's path/host/argv.
import type { SearchMatch, FileEntry, WorkspaceFacts } from "./workspace";
import type { RelativePath } from "./paths";
import type { WebCitation } from "./web";
import type { GitStatus } from "./git";
import type { IsolationLevel } from "./permissions";

/** Tools built into NOVA for J2-A. Order is stable: tool lists sent to models keep it (prompt cache). */
export const BUILTIN_TOOL_NAMES = [
  "read_file",
  "list_dir",
  "glob",
  "search_text",
  "write_file",
  "edit_file",
  "move_path",
  "delete_path",
  "run_command",
  "run_tests",
  "git_status",
  "git_diff",
  "git_commit",
  "web_search",
  "fetch_page",
] as const;

export type BuiltinToolName = (typeof BUILTIN_TOOL_NAMES)[number];

/**
 * MCP tools are exposed to the model as `mcp__<serverSlug>__<toolSlug>`. Slugs match
 * [a-zA-Z0-9-]+ (no "_" runs of two) so the name stays within the provider limit
 * `^[a-zA-Z0-9_-]{1,64}$`; see `mcpToolName`.
 */
export type McpToolName = `mcp__${string}__${string}`;

export type ToolName = BuiltinToolName | McpToolName;

const MCP_TOOL_NAME = /^mcp__([a-zA-Z0-9-]+)__([a-zA-Z0-9-]+)$/;
const TOOL_NAME_MAX = 64;

export function isBuiltinToolName(value: string): value is BuiltinToolName {
  return (BUILTIN_TOOL_NAMES as readonly string[]).includes(value);
}

export function isMcpToolName(value: string): value is McpToolName {
  return value.length <= TOOL_NAME_MAX && MCP_TOOL_NAME.test(value);
}

export function isToolName(value: string): value is ToolName {
  return isBuiltinToolName(value) || isMcpToolName(value);
}

/** Slug of an MCP server or tool name: runs of other characters become "-", trimmed. */
export function mcpSlug(value: string): string {
  return value.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "x";
}

/**
 * Model-facing name of an MCP tool, or null when it cannot fit the 64-character limit (the tool
 * is then not offered to the model; the manager shows why). Collisions between two tools whose
 * slugs coincide are resolved by the MCP host (it keeps the first in sorted order).
 */
export function mcpToolName(serverSlug: string, toolName: string): McpToolName | null {
  const name = `mcp__${mcpSlug(serverSlug)}__${mcpSlug(toolName)}` as const;
  return name.length <= TOOL_NAME_MAX ? name : null;
}

export function parseMcpToolName(name: string): { serverSlug: string; toolSlug: string } | null {
  const match = MCP_TOOL_NAME.exec(name);
  if (!match?.[1] || !match[2]) return null;
  return { serverSlug: match[1], toolSlug: match[2] };
}

/**
 * What a tool call does, which is what the permission engine reasons about.
 * - `read`: reads workspace files or state, no side effect.
 * - `write` / `delete`: changes workspace files (checkpointed, restorable).
 * - `execute`: runs a process in the workspace (isolation level applies).
 * - `network`: leaves the machine (web search, page fetch, remote MCP).
 * - `git_mutation`: changes the repository (commit, branch…).
 * - `external`: irreversible effect outside NOVA's reach (MCP tool with side effects, deploy…);
 *   never rememberable as `allow` (S6).
 */
export const OPERATION_CLASSES = ["read", "write", "delete", "execute", "network", "git_mutation", "external"] as const;
export type OperationClass = (typeof OPERATION_CLASSES)[number];

/** Minimal JSON Schema object used for tool inputs (the subset providers accept for function tools). */
export interface JsonSchemaObject {
  type: "object";
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  description?: string;
}

/** Any JSON Schema node; kept open because MCP servers send arbitrary (untrusted) schemas. */
export type JsonSchema = { [key: string]: unknown };

export interface ToolDefinition {
  name: ToolName;
  /** Model-facing description (English). For MCP tools this text is untrusted server data. */
  description: string;
  inputSchema: JsonSchemaObject;
  operation: OperationClass;
}

/** One call requested by the model, after JSON repair and schema validation of the arguments. */
export interface ToolCall {
  /** NOVA id (uuid), distinct from the provider's `tool_call_id`, which is kept for the transcript. */
  id: string;
  providerCallId: string | null;
  missionId: string;
  name: ToolName;
  arguments: Record<string, unknown>;
  requestedAt: number;
}

export type ToolCallState = "requested" | "denied" | "running" | "succeeded" | "failed" | "cancelled";

export type ToolErrorCode =
  | "invalid_arguments"
  | "permission_denied"
  | "not_found"
  | "conflict"
  | "outside_workspace"
  | "excluded_path"
  | "too_large"
  | "timeout"
  | "cancelled"
  | "unavailable"
  | "failed";

/**
 * Where the content of a result comes from. Anything but `nova` is untrusted data: it is wrapped
 * as "data, not instructions" before reaching the model and taints the context (W5).
 */
export type ProvenanceSource = "nova" | "workspace_file" | "command_output" | "git" | "web" | "mcp";

export interface Provenance {
  source: ProvenanceSource;
  untrusted: boolean;
  /** Relative path, URL, `server/tool`, or command, when meaningful. Display only. */
  ref: string | null;
}

/** Structured, UI-facing view of a tool result (cards). Lists are capped by the producer. */
export type ToolDisplay =
  | { kind: "text"; text: string }
  | { kind: "error"; code: ToolErrorCode; message: string }
  | { kind: "file_read"; path: RelativePath; startLine: number; endLine: number; totalLines: number | null }
  | { kind: "file_list"; path: RelativePath; entries: FileEntry[]; truncated: boolean }
  | { kind: "search"; pattern: string; matches: SearchMatch[]; truncated: boolean }
  | {
      kind: "file_change";
      change: "created" | "modified" | "moved" | "deleted";
      path: RelativePath;
      fromPath: RelativePath | null;
      additions: number;
      deletions: number;
      checkpointId: string | null;
    }
  | {
      kind: "command";
      argv: string[];
      cwd: RelativePath;
      exitCode: number | null;
      signal: string | null;
      durationMs: number;
      /** Last lines of combined output (capped); the full output is an artifact. */
      outputTail: string;
      outputArtifactId: string | null;
      isolationLevel: IsolationLevel;
    }
  | {
      kind: "tests";
      runner: NonNullable<WorkspaceFacts["testRunner"]>["name"] | "unknown";
      passed: number | null;
      failed: number | null;
      skipped: number | null;
      exitCode: number | null;
      proofId: string | null;
    }
  | { kind: "git_status"; status: GitStatus }
  | { kind: "git_diff"; patch: string; truncated: boolean }
  | { kind: "git_commit"; sha: string; message: string }
  | { kind: "web_search"; query: string; citations: WebCitation[]; costUsd: number | null }
  | { kind: "web_page"; url: string; title: string | null; truncated: boolean }
  | { kind: "mcp"; server: string; tool: string; isError: boolean; text: string };

export interface ToolResult {
  callId: string;
  ok: boolean;
  /** Text returned to the model: what it needs next, already bounded and provenance-wrapped. */
  content: string;
  display: ToolDisplay;
  provenance: Provenance;
  durationMs: number;
}

/** Hard caps shared by executors and the UI (bytes/characters). */
export const TOOL_LIMITS = {
  /** Largest file read_file returns in one call (characters of content). */
  readMaxChars: 200_000,
  /** Largest tool result content sent back to the model. */
  resultMaxChars: 50_000,
  /** Output kept in memory per command before spilling to an artifact. */
  commandOutputMaxBytes: 1_000_000,
  /** Default and maximum command timeouts. */
  commandTimeoutMs: 120_000,
  commandTimeoutMaxMs: 30 * 60_000,
} as const;
