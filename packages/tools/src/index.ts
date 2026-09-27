// @nova/tools — agent tool definitions, argument schemas and executors (A2/A3/A4/A5/W1/W2).
//
// Contract for the feature implementation:
// - One `ToolExecutor` per BuiltinToolName; `definitions()` returns them in BUILTIN_TOOL_NAMES order
//   (stable for the prompt cache), filtered by the mode's tool set.
// - Model arguments: JSON repaired with `jsonrepair`, then validated with the executor's zod
//   `argsSchema`. On failure the error goes back to the model as a tool result (never executed).
// - `permissionFacts(args)` extracts what the engine needs (relative path, host, argv) BEFORE
//   execution; main resolves/contains paths (S2) and evaluates; only then `execute` runs (in the
//   worker that owns the resource: fs-worker for files/search, pty-host for commands, main for web).
// - Results: `content` is what the model needs next (bounded by TOOL_LIMITS, wrapped with its
//   provenance as data-not-instructions); `display` is the structured card for the UI.
// - Writes go through the checkpoint store first (A10) and check `expectedHash` (conflict = refusal).
import type { z } from "zod";
import type { OperationClass, PermissionRequest, ToolDefinition, ToolName, ToolResult } from "@nova/shared";

export interface ToolExecutionContext {
  workspaceId: string;
  missionId: string;
  callId: string;
  /** Aborted when the user stops the mission: executors kill child processes and return `cancelled`. */
  signal: AbortSignal;
}

export type ToolPermissionFacts = Pick<PermissionRequest, "path" | "host" | "argv">;

export interface ToolExecutor<Args = unknown> {
  readonly name: ToolName;
  readonly operation: OperationClass;
  readonly definition: ToolDefinition;
  readonly argsSchema: z.ZodType<Args>;
  permissionFacts(args: Args): ToolPermissionFacts;
  execute(args: Args, context: ToolExecutionContext): Promise<ToolResult>;
}

/** Outcome of parsing the model's raw argument string for a tool. */
export type ParsedToolArguments<Args> =
  | { ok: true; args: Args; repaired: boolean }
  | { ok: false; error: string };

export interface ToolRegistry {
  definitions(allowed: ReadonlySet<ToolName>): ToolDefinition[];
  get(name: ToolName): ToolExecutor | null;
  parseArguments(name: ToolName, raw: string): ParsedToolArguments<unknown>;
}
