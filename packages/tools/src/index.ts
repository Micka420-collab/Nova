// @nova/tools — agent tool definitions, argument schemas and executors (A2/A3/A4/A5/W1/W2).
//
// - One `ToolExecutor` per BuiltinToolName (+ one generic executor per enabled MCP tool);
//   `definitions()` returns them in BUILTIN_TOOL_NAMES order then MCP names sorted (stable for the
//   prompt cache), filtered by the allowed set (mode tool set, see ./modes).
// - Model arguments: JSON repaired with `jsonrepair`, then validated with the executor's zod
//   `argsSchema`. On failure the error goes back to the model as a tool result (never executed).
// - `permissionFacts(args)` extracts what the engine needs (relative paths, host, argv) BEFORE
//   execution; main evaluates every entry and only then calls `execute`.
// - Executors are thin adapters over injected APIs (./apis): they never touch the disk, a process,
//   git or the network directly.
// - Results: `content` is what the model needs next (bounded by TOOL_LIMITS, fenced with its
//   provenance as data-not-instructions); `display` is the structured card for the UI.
// - Writes: the gateway captures a checkpoint first (A10); executors check the last-seen hash
//   (conflict = refusal, nothing overwritten).
import type { z } from "zod";
import type {
  ContentHash,
  OperationClass,
  PermissionRequest,
  RelativePath,
  ToolDefinition,
  ToolName,
  ToolResult,
} from "@nova/shared";

export interface ToolExecutionContext {
  workspaceId: string;
  missionId: string;
  callId: string;
  /** Aborted when the user stops the mission: executors kill child processes and return `cancelled`. */
  signal: AbortSignal;
  /** Checkpoint captured by the gateway before a write/delete (A10); null otherwise. */
  checkpointId: string | null;
  /**
   * Hash of each file as the agent last saw it in this mission (read or written). A whole-file
   * overwrite requires the current hash to match; a mismatch means the user changed it since.
   */
  seenVersions: Map<RelativePath, ContentHash>;
  /** Live command output (pushed as `tool.output`, never stored). */
  onOutput?: (stream: "stdout" | "stderr", chunk: string) => void;
}

export type ToolPermissionFacts = Pick<PermissionRequest, "path" | "host" | "argv">;

export interface ToolExecutor<Args = unknown> {
  readonly name: ToolName;
  readonly operation: OperationClass;
  readonly definition: ToolDefinition;
  readonly argsSchema: z.ZodType<Args>;
  /** One entry per target (a move has two paths); the gateway evaluates each, strictest wins. */
  permissionFacts(args: Args): ToolPermissionFacts[];
  /** Paths to snapshot before execution (write/delete operations only). */
  checkpointPaths(args: Args): RelativePath[];
  execute(args: Args, context: ToolExecutionContext): Promise<ToolResult>;
}

/** Outcome of parsing the model's raw argument string for a tool. */
export type ParsedToolArguments<Args> =
  | { ok: true; args: Args; repaired: boolean }
  | { ok: false; error: string };

export interface ToolRegistry {
  definitions(allowed: ReadonlySet<ToolName>): ToolDefinition[];
  get(name: string): ToolExecutor | null;
  parseArguments(name: ToolName, raw: string): ParsedToolArguments<unknown>;
}

export type {
  BackgroundProcess,
  CommandOutcome,
  CommandOutputListener,
  CommandRunner,
  CommandSpec,
  GitApi,
  McpApi,
  McpCallOutcome,
  ToolDeps,
  WebApi,
  WorkspaceFsApi,
} from "./apis";
export { parseToolArguments } from "./args";
export { classifyCommand, type CommandClass } from "./command-class";
export {
  createProcessCommandRunner,
  scrubCommandEnv,
  type ProcessCommandRunnerOptions,
} from "./command-runner";
export { ToolFailure, capText, errorResult, makeResult, provenance, wrapUntrusted } from "./content";
export { MODE_OPERATIONS, mcpOperation, toolsForMode } from "./modes";
export { createToolRegistry, type ToolRegistryOptions } from "./registry";
export { parseTestOutput, testInvocation, type ParsedTestReport } from "./test-report";
/**
 * The zod instance of the tool schemas, shared with @nova/missions (plan schema) so both validate
 * with one zod copy. TODO(lead): declare `zod` in @nova/missions and import it directly.
 */
export { z } from "zod";
