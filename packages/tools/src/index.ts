// @nova/tools — agent tool definitions, argument schemas and executors (A2/A3/A4/A5/W1/W2).
//
// - One `ToolExecutor` per BuiltinToolName (+ one per enabled MCP tool offer);
//   `definitions()` returns them in BUILTIN_TOOL_NAMES order then MCP names sorted (stable for the
//   prompt cache), filtered by the allowed set (the mode's tool set, computed by @nova/missions).
// - Model arguments: JSON repaired with `jsonrepair`, then validated with the executor's zod
//   `argsSchema`. On failure the error goes back to the model as a tool result (never executed).
// - `permissionFacts(args)` extracts what the engine needs (relative paths, host, real argv)
//   BEFORE execution; `ownerPolicy` adds the resource owner's own rule (web domain policy, MCP
//   per-tool permission). Main evaluates both and only then calls `execute`.
// - Executors are thin adapters over injected APIs (./apis): they never touch the disk, a process,
//   git or the network directly.
// - Results: `content` is what the model needs next (bounded by TOOL_LIMITS, fenced with its
//   provenance as data-not-instructions); `display` is the structured card for the UI.
// - Writes: the gateway creates a checkpoint first (A10) and passes its id; the file API snapshots
//   each file into it and checks the last-seen hash (conflict = refusal, nothing overwritten).
import type { z } from "zod";
import type {
  ContentHash,
  MissionEvent,
  OperationClass,
  PermissionReason,
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
  /** Checkpoint created by the gateway before a write/delete (A10); null otherwise. */
  checkpointId: string | null;
  /**
   * Hash of each file as the agent last saw it in this mission (read or written). Overwrites and
   * edits require the current hash to match; a mismatch means the user changed it since.
   */
  seenVersions: Map<RelativePath, ContentHash>;
  /** Hosts the mission contract allows (W4); null = no extra restriction. */
  missionHosts: readonly string[] | null;
  /** Live command output (pushed as `tool.output`, never stored). */
  onOutput?: (stream: "stdout" | "stderr", chunk: string) => void;
  /** J2-B: journals a lane event of this mission (skill loaded, chain run, sub-mission, terminal). */
  record?: (event: ToolRecordedEvent) => void;
  /**
   * L4, run_chain only: runs one call of the program through the SAME gateway pipeline (parse,
   * mode, permission engine, approval, checkpoint, audit) with `parentCallId` = this call.
   * run_chain and start_submission are refused inside a program (CHAIN_FORBIDDEN_TOOLS).
   */
  runNested?: (call: { name: string; rawArguments: string }) => Promise<ToolResult>;
}

type WithoutEnvelope<T> = T extends unknown ? Omit<T, "id" | "seq" | "at" | "missionId"> : never;

/** Mission events a tool executor may journal through `ToolExecutionContext.record`. */
export type ToolRecordedEvent = WithoutEnvelope<
  Extract<
    MissionEvent,
    { type: "tool.terminal" | "process.started" | "skill.loaded" | "chain.started" | "chain.finished" | "submission.started" }
  >
>;

export type ToolPermissionFacts = Pick<PermissionRequest, "path" | "host" | "argv">;

/** Condition set by the owner of the resource, on top of the permission engine (strictest wins). */
export interface OwnerPolicy {
  decision: "ask" | "deny";
  reason: Extract<PermissionReason, "domain_policy" | "mcp_tool_policy">;
  /** Model-facing explanation when it refuses (English). */
  detail: string;
}

/** A tool result plus what the gateway needs for proofs (never sent to the model). */
export interface ExecutedToolResult extends ToolResult {
  /** Exact argv that ran (commands, tests). */
  argv?: string[];
}

export interface ToolExecutor<Args = unknown> {
  readonly name: ToolName;
  readonly operation: OperationClass;
  readonly definition: ToolDefinition;
  readonly argsSchema: z.ZodType<Args>;
  /** One entry per target (a move has two paths); the gateway evaluates each, strictest wins. */
  permissionFacts(args: Args): ToolPermissionFacts[] | Promise<ToolPermissionFacts[]>;
  /** Owner rule (web domain policy, MCP tool permission); null = none. A throw means deny. */
  ownerPolicy?(args: Args, context: { workspaceId: string; missionHosts: readonly string[] | null }): Promise<OwnerPolicy | null>;
  /** Paths to snapshot before execution (write/delete operations only). */
  checkpointPaths(args: Args): RelativePath[];
  /** Never throws once wrapped by the registry: failures become error results. */
  execute(args: Args, context: ToolExecutionContext): Promise<ExecutedToolResult>;
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
  ChainApi,
  ChainRunContext,
  ProcessApi,
  SkillLoadOutcome,
  SkillsApi,
  SubMissionStart,
  SubmissionsApi,
  CommandOutcome,
  CommandOutputListener,
  CommandRunner,
  CommandSpec,
  FileChangeOutcome,
  FileReadOutcome,
  GitApi,
  McpApi,
  McpToolOffer,
  ToolDeps,
  WebApi,
  WebCallContext,
  WorkspaceFileApi,
} from "./apis";
export { parseToolArguments } from "./args";
export {
  createProcessCommandRunner,
  scrubCommandEnv,
  type ProcessCommandRunner,
  type ProcessCommandRunnerOptions,
} from "./command-runner";
export { ToolFailure, capText, errorResult, makeResult, provenance, wrapUntrusted } from "./content";
export { createToolRegistry, toToolFailure, type ToolRegistryOptions } from "./registry";
export { createHarnessExecutors } from "./harness-tools";
export { parseTestOutput, testInvocation, type ParsedTestReport } from "./test-report";
/**
 * The zod instance of the tool schemas, shared with @nova/missions (plan and link schemas) so
 * both validate with one zod copy. TODO(lead): declare `zod` in @nova/missions and import it there.
 */
export { z } from "zod";
