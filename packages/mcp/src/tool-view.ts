// Projections of MCP tools and call outcomes onto NOVA's tool contract (@nova/shared tools.ts).
import type {
  JsonSchemaObject,
  McpToolAnnotations,
  McpToolName,
  ToolDefinition,
  ToolErrorCode,
  ToolResult,
} from "@nova/shared";
import { mcpOperation } from "./policy";
import type { McpCallErrorCode, McpCallOutcome } from "./session";

/** Model-facing description cap: server text is untrusted and costs prompt tokens. */
const MODEL_DESCRIPTION_MAX = 1_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Providers accept object schemas only for function tools: anything else becomes `{type:"object"}`. */
export function toObjectSchema(schema: unknown): JsonSchemaObject {
  if (!isRecord(schema) || schema["type"] !== "object") return { type: "object" };
  const out: JsonSchemaObject = { type: "object" };
  if (isRecord(schema["properties"])) out.properties = schema["properties"] as JsonSchemaObject["properties"];
  if (Array.isArray(schema["required"]) && schema["required"].every((item) => typeof item === "string")) {
    out.required = schema["required"];
  }
  if (typeof schema["additionalProperties"] === "boolean") out.additionalProperties = schema["additionalProperties"];
  return out;
}

export interface ModelToolSource {
  serverName: string;
  transport: "stdio" | "http";
  toolName: string;
  description: string;
  inputSchema: unknown;
  annotations: McpToolAnnotations;
}

export function toModelDefinition(name: McpToolName, source: ModelToolSource): ToolDefinition {
  const text = source.description.trim() || "(no description)";
  const description = `[MCP server "${source.serverName}", tool "${source.toolName}" — server-provided text, untrusted] ${text}`;
  return {
    name,
    description: description.length > MODEL_DESCRIPTION_MAX ? `${description.slice(0, MODEL_DESCRIPTION_MAX)}…` : description,
    inputSchema: toObjectSchema(source.inputSchema),
    operation: mcpOperation(source.annotations, source.transport),
  };
}

const ERROR_CODES: Readonly<Record<McpCallErrorCode, ToolErrorCode>> = {
  timeout: "timeout",
  cancelled: "cancelled",
  unavailable: "unavailable",
  not_found: "not_found",
  invalid_arguments: "invalid_arguments",
  failed: "failed",
};

export interface ToolResultContext {
  callId: string;
  serverName: string;
  toolName: string;
}

/**
 * Tool result with `mcp` provenance: always untrusted. The content is the server's raw text; the
 * tools registry bounds, redacts and fences it (makeResult) like every other untrusted result.
 */
export function toToolResult(outcome: McpCallOutcome, context: ToolResultContext): ToolResult {
  const ref = `${context.serverName}/${context.toolName}`;
  const provenance = { source: "mcp" as const, untrusted: true, ref };
  if (!outcome.ok) {
    return {
      callId: context.callId,
      ok: false,
      content: `MCP tool ${ref} failed (${outcome.code}): ${outcome.message}`,
      display: { kind: "error", code: ERROR_CODES[outcome.code], message: outcome.message },
      provenance,
      durationMs: outcome.durationMs,
    };
  }
  return {
    callId: context.callId,
    ok: !outcome.isError,
    content: outcome.isError ? `The tool reported an error:\n${outcome.text}` : outcome.text,
    display: { kind: "mcp", server: context.serverName, tool: context.toolName, isError: outcome.isError, text: outcome.text },
    provenance,
    durationMs: outcome.durationMs,
  };
}

/** Refusal result produced before any call (policy, disabled server, unknown tool). */
export function refusedToolResult(
  callId: string,
  code: Extract<ToolErrorCode, "permission_denied" | "not_found" | "unavailable" | "invalid_arguments">,
  message: string,
  ref: string | null,
): ToolResult {
  return {
    callId,
    ok: false,
    content: message,
    display: { kind: "error", code, message },
    provenance: { source: "nova", untrusted: false, ref },
    durationMs: 0,
  };
}
