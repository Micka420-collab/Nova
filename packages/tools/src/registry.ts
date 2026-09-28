// Tool registry of one mission: built-ins + the enabled MCP tool offers (snapshot taken at mission
// start), stable order, argument parsing, and executors whose failures always become results.
import { z } from "zod";
import { BUILTIN_TOOL_NAMES, type ToolDefinition, type ToolErrorCode, type ToolName } from "@nova/shared";
import type { McpToolOffer, ToolDeps } from "./apis";
import { parseToolArguments } from "./args";
import { createBuiltinExecutors } from "./builtin";
import { ToolFailure, errorResult } from "./content";
import type { ExecutedToolResult, ToolExecutionContext, ToolExecutor, ToolRegistry } from "./index";

export interface ToolRegistryOptions {
  deps: ToolDeps;
  /** Enabled MCP tools of the workspace (`McpService.listToolsForModel`), snapshot at mission start (their permission is re-read per call). */
  mcpTools?: readonly McpToolOffer[];
}

const KNOWN_ERROR_CODES: readonly ToolErrorCode[] = [
  "invalid_arguments", "permission_denied", "not_found", "conflict", "outside_workspace", "excluded_path",
  "too_large", "timeout", "cancelled", "unavailable", "failed",
];

/**
 * Error codes of the injected services (workspace L2, web L4) mapped to tool codes. Their messages
 * are secret-free English (or French for the exfiltration guard) and tell the model what happened.
 */
const FOREIGN_ERROR_CODES: Readonly<Record<string, ToolErrorCode>> = {
  invalid_path: "invalid_arguments",
  invalid_argument: "invalid_arguments",
  invalid_request: "invalid_arguments",
  invalid_url: "invalid_arguments",
  already_exists: "conflict",
  not_a_directory: "invalid_arguments",
  not_a_file: "invalid_arguments",
  binary: "too_large",
  policy_denied: "permission_denied",
  policy_ask: "permission_denied",
  blocked_address: "permission_denied",
  exfiltration_blocked: "permission_denied",
  too_many_redirects: "failed",
  aborted: "cancelled",
  unsupported_content_type: "failed",
  http_error: "failed",
  network: "unavailable",
  search_unavailable: "unavailable",
  search_failed: "failed",
};

function messageOf(error: unknown, fallback: string): string {
  const explanation = (error as { explanation?: unknown } | null)?.explanation;
  const text = typeof explanation === "string" ? explanation : error instanceof Error ? error.message : fallback;
  return text.slice(0, 500);
}

/** Maps any executor failure to a typed code; errors without a known code never leak their message. */
export function toToolFailure(error: unknown, signal: AbortSignal): { code: ToolErrorCode; message: string } {
  if (signal.aborted) return { code: "cancelled", message: "stopped by the user" };
  if (error instanceof ToolFailure) return { code: error.code, message: error.message };
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  if (typeof code === "string") {
    if ((KNOWN_ERROR_CODES as readonly string[]).includes(code)) return { code: code as ToolErrorCode, message: messageOf(error, code) };
    const mapped = FOREIGN_ERROR_CODES[code];
    if (mapped) return { code: mapped, message: messageOf(error, code) };
  }
  return { code: "failed", message: "the tool failed unexpectedly; try another approach" };
}

function guarded<Args>(executor: ToolExecutor<Args>): ToolExecutor<Args> {
  return {
    ...executor,
    async execute(args: Args, context: ToolExecutionContext): Promise<ExecutedToolResult> {
      const started = Date.now();
      if (context.signal.aborted) return errorResult(context.callId, "cancelled", "stopped by the user");
      try {
        return await executor.execute(args, context);
      } catch (error) {
        const failure = toToolFailure(error, context.signal);
        return errorResult(context.callId, failure.code, failure.message, Date.now() - started);
      }
    },
  };
}

/** One MCP tool: the definition comes from the MCP host (untrusted description already labeled). */
function mcpExecutor(offer: McpToolOffer, deps: ToolDeps): ToolExecutor<Record<string, unknown>> {
  const { definition } = offer;
  const ref = `${offer.serverName}/${offer.toolName}`;
  return {
    name: definition.name,
    operation: definition.operation,
    definition,
    argsSchema: z.record(z.string(), z.unknown()),
    permissionFacts: () => [{}],
    // M5: a tool set to "ask" in the MCP manager asks on every call, whatever the profile says.
    // The rule is read from the owner at each call, never from the mission-start snapshot: the
    // user can switch a tool to "ask" (or deny it) while a mission runs, and execute() below
    // calls it as approved.
    async ownerPolicy(_args, scope) {
      const live = (await deps.mcp?.listToolsForModel(scope.workspaceId, { connect: false }))?.find(
        (tool) => tool.definition.name === definition.name,
      );
      if (!live) return { decision: "deny", reason: "mcp_tool_policy", detail: `${ref} is no longer available (denied, disabled or disconnected)` };
      return live.permission === "ask" ? { decision: "ask", reason: "mcp_tool_policy", detail: `${ref} asks before each call` } : null;
    },
    checkpointPaths: () => [],
    async execute(args, context) {
      if (!deps.mcp) throw new ToolFailure("unavailable", "MCP is not available in this session");
      // Reaching execute means the gateway allowed, or the user approved, this exact call.
      const result = await deps.mcp.callTool(definition.name, args, {
        workspaceId: context.workspaceId,
        callId: context.callId,
        signal: context.signal,
        approved: true,
      });
      return { ...result, callId: context.callId };
    },
  };
}

export function createToolRegistry(options: ToolRegistryOptions): ToolRegistry {
  const executors = new Map<string, ToolExecutor>();
  for (const executor of createBuiltinExecutors(options.deps)) executors.set(executor.name, guarded(executor));
  const mcpNames: string[] = [];
  for (const offer of options.mcpTools ?? []) {
    const name = offer.definition.name;
    if (executors.has(name)) continue;
    executors.set(name, guarded(mcpExecutor(offer, options.deps)) as ToolExecutor);
    mcpNames.push(name);
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
