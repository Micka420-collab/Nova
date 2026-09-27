// Tool registry of one mission: built-ins + the enabled MCP tools snapshot, stable order, argument
// parsing, and executors whose failures always become results (never exceptions).
import { z } from "zod";
import {
  BUILTIN_TOOL_NAMES,
  type JsonSchemaObject,
  type McpToolInfo,
  type ToolDefinition,
  type ToolErrorCode,
  type ToolName,
  type ToolResult,
} from "@nova/shared";
import type { ToolDeps } from "./apis";
import { parseToolArguments } from "./args";
import { createBuiltinExecutors } from "./builtin";
import { ToolFailure, errorResult, makeResult, provenance } from "./content";
import type { ToolExecutionContext, ToolExecutor, ToolRegistry } from "./index";
import { mcpOperation } from "./modes";

export interface ToolRegistryOptions {
  deps: ToolDeps;
  /** Enabled MCP tools of the workspace (snapshot taken when the mission starts). */
  mcpTools?: readonly McpToolInfo[];
}

const KNOWN_ERROR_CODES: readonly ToolErrorCode[] = [
  "invalid_arguments", "permission_denied", "not_found", "conflict", "outside_workspace", "excluded_path",
  "too_large", "timeout", "cancelled", "unavailable", "failed",
];

/** Maps any executor failure to a typed code; unknown errors never leak their message. */
function toFailure(error: unknown, signal: AbortSignal): { code: ToolErrorCode; message: string } {
  if (signal.aborted) return { code: "cancelled", message: "stopped by the user" };
  if (error instanceof ToolFailure) return { code: error.code, message: error.message };
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  if (typeof code === "string" && (KNOWN_ERROR_CODES as readonly string[]).includes(code)) {
    return { code: code as ToolErrorCode, message: error instanceof Error ? error.message.slice(0, 500) : code };
  }
  if (code === "invalid_request") return { code: "invalid_arguments", message: error instanceof Error ? error.message.slice(0, 500) : "invalid request" };
  return { code: "failed", message: "the tool failed unexpectedly; try another approach" };
}

function guarded<Args>(executor: ToolExecutor<Args>): ToolExecutor<Args> {
  return {
    ...executor,
    async execute(args: Args, context: ToolExecutionContext): Promise<ToolResult> {
      const started = Date.now();
      if (context.signal.aborted) return errorResult(context.callId, "cancelled", "stopped by the user");
      try {
        return await executor.execute(args, context);
      } catch (error) {
        const failure = toFailure(error, context.signal);
        return errorResult(context.callId, failure.code, failure.message, Date.now() - started);
      }
    },
  };
}

/** Untrusted MCP schema reduced to an object schema providers accept. */
function mcpInputSchema(schema: unknown): JsonSchemaObject {
  if (typeof schema === "object" && schema !== null && (schema as Record<string, unknown>)["type"] === "object") {
    return schema as JsonSchemaObject;
  }
  return { type: "object", properties: {} };
}

function mcpExecutor(info: McpToolInfo & { qualifiedName: NonNullable<McpToolInfo["qualifiedName"]> }, deps: ToolDeps): ToolExecutor<Record<string, unknown>> {
  const name = info.qualifiedName;
  const operation = mcpOperation(info.annotations);
  const definition: ToolDefinition = {
    name,
    description: `[MCP tool "${info.name}" — description provided by an external server, not by NOVA] ${info.description.slice(0, 2_000)}`,
    inputSchema: mcpInputSchema(info.inputSchema),
    operation,
  };
  return {
    name,
    operation,
    definition,
    argsSchema: z.record(z.string(), z.unknown()),
    permissionFacts: () => [{}],
    checkpointPaths: () => [],
    async execute(args, context) {
      const started = Date.now();
      if (!deps.mcp) throw new ToolFailure("unavailable", "MCP is not available in this session");
      const outcome = await deps.mcp.callTool(
        { workspaceId: context.workspaceId, missionId: context.missionId, name, arguments: args },
        context.signal,
      );
      return makeResult({
        callId: context.callId,
        ok: !outcome.isError,
        content: outcome.text || "(empty result)",
        display: { kind: "mcp", server: outcome.server, tool: info.name, isError: outcome.isError, text: outcome.text.slice(0, 4_000) },
        provenance: provenance("mcp", `${outcome.server}/${info.name}`),
        durationMs: Date.now() - started,
      });
    },
  };
}

export function createToolRegistry(options: ToolRegistryOptions): ToolRegistry {
  const executors = new Map<string, ToolExecutor>();
  for (const executor of createBuiltinExecutors(options.deps)) executors.set(executor.name, guarded(executor));
  const mcpNames: string[] = [];
  for (const info of options.mcpTools ?? []) {
    const qualified = info.qualifiedName;
    if (!qualified || executors.has(qualified)) continue;
    executors.set(qualified, guarded(mcpExecutor({ ...info, qualifiedName: qualified }, options.deps)) as ToolExecutor);
    mcpNames.push(qualified);
  }
  mcpNames.sort();
  const order: string[] = [...BUILTIN_TOOL_NAMES, ...mcpNames];

  return {
    definitions(allowed) {
      return order
        .filter((name) => allowed.has(name as ToolName))
        .map((name) => executors.get(name)?.definition)
        .filter((definition): definition is ToolDefinition => definition !== undefined);
    },
    get(name) {
      return executors.get(name) ?? null;
    },
    parseArguments(name, raw) {
      const executor = executors.get(name);
      if (!executor) return { ok: false, error: `unknown tool "${name}"` };
      return parseToolArguments(raw, executor.argsSchema);
    },
  };
}

