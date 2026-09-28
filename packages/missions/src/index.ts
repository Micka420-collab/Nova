// @nova/missions — mission loop (A1/A9/A12/A13), planner, tool gateway, journal and review.
//
// Process split:
// - The loop (`MissionLoop`) runs inside the `agent-runtime` utilityProcess. It holds NO key and
//   opens no socket: generations go through `ProviderProxy` (main adds the key and reserves the
//   budget), tool calls through `ToolGateway` (main parses, evaluates permission, asks, checkpoints,
//   then executes). Both travel over one MessagePort (`./channel`).
// - Main owns the journal (`createMissionJournal`), the gateway (`createToolGateway`) and the
//   controller (`createMissionController`: plan/start/pause/resume/stop/list/get/review).
//
// Invariants: exactly ONE terminal event per mission (enforced by the loop AND the journal); one
// `tool.finished` per `tool.requested`; no tool runs without a recorded `allow` (engine allow or
// approved approval); `mission.succeeded` only when every checkable acceptance criterion was
// verified by a real tool result (A4) — `manual` criteria stay "to confirm by you".
// Bounds: iterations, duration (contract.maxDurationMs), budget with reservation before each model
// call (D11), no-progress detection (same call + same result ×3 → suspend `no_progress`).
// Tools sent to the model are the mode's set in stable order (prompt cache), resent every request.
import type {
  Mission,
  MissionContract,
  MissionEvent,
  MissionTask,
  ProviderErrorCode,
  ToolDefinition,
  ToolResult,
  UsageSummary,
  WorkMode,
} from "@nova/shared";

/** Provider access through main (the runtime never sees the API key). */
export interface ProviderProxy {
  /** Throws `ProxyError` on failure (including `budget` refusals and aborts). */
  stream(request: ProxyStreamRequest, signal: AbortSignal): AsyncIterable<ProxyStreamEvent>;
}

export interface ProxyStreamRequest {
  /** Budget owner: main reserves the estimated cost on this mission before calling. */
  missionId: string;
  modelId: string;
  messages: ProxyMessage[];
  tools: ToolDefinition[];
  /** OpenRouter web plugin, only when the contract allows it (D3). */
  webSearch: boolean;
  /** Output cap of the call (bounds the reservation). */
  maxTokens: number;
  /** What the call is for (cost report per phase, Mo6). */
  purpose: "plan" | "step";
}

export type ProxyMessage =
  | { role: "system" | "user"; content: string }
  | {
      role: "assistant";
      content: string;
      toolCalls: { id: string; name: string; arguments: string }[];
      /** Opaque, echoed back unchanged; never shown nor stored (ADR-008). */
      reasoningDetails?: unknown[];
    }
  | { role: "tool"; toolCallId: string; content: string };

export type ProxyStreamEvent =
  | { type: "meta"; servedModel: string | null; servedProvider: string | null }
  | { type: "text"; text: string }
  | { type: "reasoning" }
  | { type: "reasoning_details"; details: unknown[] }
  | { type: "tool_call_delta"; index: number; id: string | null; name: string | null; argumentsDelta: string }
  | { type: "citation"; url: string; title: string | null; snippet: string | null }
  | { type: "usage"; usage: UsageSummary }
  | { type: "finish"; reason: "stop" | "tool_calls" | "length" | "content_filter" | "error" | "unknown" };

export type ProxyErrorCode = ProviderErrorCode | "budget" | "daily_budget" | "no_tool_support" | "invalid_request";

export class ProxyError extends Error {
  constructor(
    readonly code: ProxyErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "ProxyError";
  }
}

/** A tool call as requested by the model; main parses and validates `rawArguments`. */
export interface ToolRunRequest {
  /** NOVA id (uuid). */
  id: string;
  providerCallId: string | null;
  missionId: string;
  name: string;
  rawArguments: string;
  requestedAt: number;
  /** L4: set by the gateway for calls issued by a run_chain program (never by the runtime). */
  parentCallId?: string | null;
}

/** Tool execution through main: permission first, then the owning executor. Never throws. */
export interface ToolGateway {
  run(request: ToolRunRequest, signal: AbortSignal): Promise<ToolResult>;
}

/** A mission event before the journal gives it an id, a seq and a timestamp. */
export type MissionEventInput = MissionEvent extends unknown ? DistributiveOmit<MissionEvent, "id" | "seq" | "at"> : never;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** Append-only event sink (runtime side: fire-and-forget to main, which stores and pushes). */
export interface MissionEventSink {
  append(event: MissionEventInput): void;
}

/** What the runtime needs to run one mission (sent by main with `mission.start`). */
export interface MissionRunSpec {
  mission: Mission;
  contract: MissionContract;
  tasks: MissionTask[];
  /** Mode tool set, stable order, as sent to the model. */
  tools: ToolDefinition[];
  /** Summary of the plan shown to the user (context for the model). */
  planSummary: string;
  /** L3: enabled skills (names + descriptions), appended to the system prompt; absent = none. */
  skillIndex?: string | null;
}

export interface MissionRuntime {
  start(spec: MissionRunSpec): Promise<void>;
  pause(missionId: string): void;
  resume(missionId: string): void;
  /** Idempotent. */
  stop(missionId: string): void;
  /** Resolves when no mission is running (used at quit). */
  idle(): Promise<void>;
}

/** System prompt of a mission, injected by the host (see @nova/agent-runtime `buildMissionSystemPrompt`). */
export type SystemPromptBuilder = (input: { mode: WorkMode; toolNames: string[]; webSearch: boolean }) => string;

export { estimateCallCost, estimateMission, type CallEstimate, type PricingLike } from "./budget";
export {
  ChannelError,
  createChannel,
  createPortPair,
  type Channel,
  type ChannelHandler,
  type PortLike,
} from "./channel";
export { buildContextPlan, type ContextPlan, type ContextPlanItem } from "./context-plan";
export {
  MissionError,
  createMissionController,
  type MissionController,
  type MissionControllerDeps,
  type MissionStoreLike,
} from "./controller";
export {
  createApprovalBridge,
  type ApprovalBridge,
  type ApprovalEventLike,
  type ApprovalServiceLike,
} from "./approval-bridge";
export {
  createToolGateway,
  missionHostsOf,
  strictestDecision,
  type ApprovalGate,
  type CheckpointGate,
  type MissionToolContext,
  type PermissionGate,
  type ToolExecutionAudit,
  type ToolGatewayDeps,
} from "./gateway";
export { HUNK_CONTEXT_LINES, diffHunks, revertHunks, unifiedPatch, type LineHunk } from "./line-diff";
export { missionToolSet } from "./tool-set";
export { createMissionJournal, eventFromRecord, type MissionJournal, type MissionJournalDeps } from "./journal";
export {
  DEFAULT_LOOP_LIMITS,
  MissionLoop,
  type ContextPreparation,
  type LoopContextHook,
  type LoopContinuationHook,
  type LoopExtensions,
  type LoopLimits,
  type MissionLoopDeps,
  type OpenCriterion,
} from "./loop";
export { NoProgressDetector } from "./no-progress";
export { PLAN_SCHEMA, planMission, type PlanOutcome } from "./planner";
export {
  connectRuntime,
  createChannelLoopExtensions,
  createChannelProviderProxy,
  createChannelToolGateway,
  serveRuntimeChannel,
  type MainRuntimeHandlers,
  type RuntimeLink,
} from "./runtime-link";
export { applyReview, buildReview, type ReviewFile, type ReviewModel, type ReviewFsGate } from "./review";
export { evaluateAcceptance, type AcceptanceEvidence } from "./acceptance";
// J2-B lanes (each lane owns its folder and its own index).
// `export *` so a lane never edits this file to publish its API.
export * from "./compaction";
export * from "./submissions";
export * from "./continuation";
