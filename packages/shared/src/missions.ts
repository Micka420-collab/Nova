// Missions (A9/A11/A12/A13): plan → act → verify, with a contract and a budget.
// `mission_events` (append-only) is the source of truth; the mission card is a projection of it.
// Invariants: exactly ONE terminal event per mission (succeeded | failed | cancelled) and one
// `tool.finished` per `tool.requested`; no tool runs without a recorded `allow`.
import { z } from "zod";
import type { UsageSummary } from "./domain";
import { EntityIdSchema, HostPatternSchema, ModelIdSchema } from "./ids";
import { RelativeEntryPathSchema, type RelativePath } from "./paths";
import type { Approval, IsolationLevel, PermissionDecision, PermissionProfile } from "./permissions";
import { OPERATION_CLASSES, type OperationClass, type ToolDisplay, type ToolName } from "./tools";
import type { Checkpoint } from "./workspace";

export const WORK_MODES = ["discuss", "understand", "plan", "build", "fix", "verify"] as const;
export type WorkMode = (typeof WORK_MODES)[number];

export type MissionState =
  | "ready"
  | "running"
  | "waiting_approval"
  | "suspended"
  | "succeeded"
  | "failed"
  | "cancelled";

export const TERMINAL_MISSION_STATES: readonly MissionState[] = ["succeeded", "failed", "cancelled"];

export function isTerminalMissionState(state: MissionState): boolean {
  return TERMINAL_MISSION_STATES.includes(state);
}

/** D11: default budgets, shown in the first contract and editable. */
export const DEFAULT_MISSION_BUDGET_USD = 0.5;
export const DEFAULT_DAILY_BUDGET_USD = 5;
export const DEFAULT_MISSION_MAX_DURATION_MS = 15 * 60_000;

export interface MissionContract {
  workspaceId: string;
  mode: WorkMode;
  profile: PermissionProfile;
  isolationLevel: IsolationLevel;
  allowedOperations: OperationClass[];
  /** Hosts the mission may reach (restricts the global web policy, never widens it — W4). */
  allowedHosts: string[];
  /** D3: web search allowed in this mission (always false in `discuss` unless the Web button is on). */
  webSearch: boolean;
  maxDurationMs: number;
  budgetUsd: number;
}

export interface Mission {
  id: string;
  workspaceId: string;
  conversationId: string | null;
  title: string;
  goal: string;
  mode: WorkMode;
  state: MissionState;
  modelId: string | null;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
  updatedAt: number;
}

export type MissionTaskState = "todo" | "running" | "verified" | "failed" | "blocked" | "skipped";

/** Criteria the runtime can check (`manual` = "to confirm by you", never auto-verified). */
export type AcceptanceKind = "test_passes" | "command_succeeds" | "file_exists" | "manual";

export interface MissionTask {
  id: string;
  missionId: string;
  seq: number;
  title: string;
  state: MissionTaskState;
  acceptance: { kind: AcceptanceKind; detail: string };
}

export interface MissionBudget {
  budgetUsd: number;
  reservedUsd: number;
  /** Sum of reported costs; `unknownCostCalls` > 0 makes it a lower bound. */
  spentUsd: number;
  unknownCostCalls: number;
  dailySpentUsd: number;
  dailyLimitUsd: number;
}

export type ProofKind = "command" | "test" | "screenshot" | "diff";

export interface Proof {
  id: string;
  missionId: string;
  taskId: string | null;
  toolCallId: string | null;
  kind: ProofKind;
  command: string[] | null;
  exitCode: number | null;
  summary: string;
  /** Artifact id holding the full output / image / patch. */
  outputRef: string | null;
  createdAt: number;
}

export type ReviewDecisionKind = "kept" | "reverted";

/** A11: per file (`hunkIndex` null) or per hunk of the mission's diff for that file. */
export interface ReviewDecision {
  path: RelativePath;
  hunkIndex: number | null;
  decision: ReviewDecisionKind;
}

/** Summary of a tool call as shown in events (arguments redacted and capped at 2 000 chars). */
export interface ToolCallSummary {
  id: string;
  name: ToolName;
  operation: OperationClass;
  argumentsPreview: string;
  path: RelativePath | null;
  host: string | null;
  argv: string[] | null;
}

export type MissionSuspendReason = "budget" | "duration" | "no_progress" | "user" | "daily_budget";
export type MissionFailureReason =
  | "acceptance_failed"
  | "provider_error"
  | "no_tool_support"
  | "iteration_limit"
  | "internal";

interface EventBase {
  /** Event id (uuid). */
  id: string;
  missionId: string;
  /** Position in the mission's log (strictly increasing, from `mission_events.seq`). */
  seq: number;
  at: number;
}

type Ev<T extends string, P> = EventBase & { type: T } & P;

export type MissionEvent =
  | Ev<"mission.created", { mission: Mission; contract: MissionContract }>
  | Ev<"mission.started", { contract: MissionContract }>
  | Ev<"mission.plan", { summary: string; tasks: MissionTask[] }>
  | Ev<"task.updated", { task: MissionTask }>
  | Ev<"tool.requested", { call: ToolCallSummary; taskId: string | null }>
  | Ev<"tool.permission", { callId: string; decision: PermissionDecision; approvalId: string | null }>
  | Ev<"tool.started", { callId: string; isolationLevel: IsolationLevel | null }>
  /** Live only: pushed to the renderer, NOT stored in mission_events (full output = artifact). */
  | Ev<"tool.output", { callId: string; stream: "stdout" | "stderr" | "pty"; chunk: string }>
  | Ev<
      "tool.finished",
      {
        callId: string;
        state: "succeeded" | "failed" | "cancelled" | "denied";
        display: ToolDisplay;
        durationMs: number;
      }
    >
  | Ev<"approval.requested", { approval: Approval }>
  | Ev<"approval.resolved", { approval: Approval }>
  /** Live only (like chat deltas); `message.completed` carries the final text. */
  | Ev<"message.delta", { messageId: string; text: string }>
  | Ev<"message.completed", { messageId: string; content: string; usage: UsageSummary | null }>
  | Ev<"proof.recorded", { proof: Proof }>
  | Ev<"checkpoint.created", { checkpoint: Checkpoint }>
  | Ev<"budget.updated", { budget: MissionBudget }>
  | Ev<"mission.suspended", { reason: MissionSuspendReason; detail: string | null }>
  | Ev<"mission.resumed", Record<never, never>>
  | Ev<"mission.succeeded", { summary: string }>
  | Ev<"mission.failed", { reason: MissionFailureReason; detail: string | null }>
  | Ev<"mission.cancelled", { by: "user" | "system" }>
  | Ev<"review.decided", { decisions: ReviewDecision[] }>;

export type MissionEventType = MissionEvent["type"];

/** Events that are pushed live but never persisted. */
export const LIVE_ONLY_MISSION_EVENTS: readonly MissionEventType[] = ["tool.output", "message.delta"];

export const TERMINAL_MISSION_EVENTS: readonly MissionEventType[] = [
  "mission.succeeded",
  "mission.failed",
  "mission.cancelled",
];

export function isTerminalMissionEvent(event: MissionEvent): boolean {
  return TERMINAL_MISSION_EVENTS.includes(event.type);
}

export interface MissionDetail {
  mission: Mission;
  contract: MissionContract;
  tasks: MissionTask[];
  proofs: Proof[];
  budget: MissionBudget;
  /** Persisted events, oldest first (at most the last 2 000; `afterSeq` pages further). */
  events: MissionEvent[];
}

export interface MissionPage {
  items: Mission[];
  hasMore: boolean;
}

// ---------------------------------------------------------------------------
// Requests

const entityId = EntityIdSchema;
const modelId = ModelIdSchema;
const hostPattern = HostPatternSchema;

export const MissionContractInputSchema = z.object({
  profile: z.enum(["read_only", "assisted", "autonomous", "custom"]),
  allowedOperations: z.array(z.enum(OPERATION_CLASSES)).max(OPERATION_CLASSES.length),
  allowedHosts: z.array(hostPattern).max(100),
  webSearch: z.boolean(),
  maxDurationMs: z.int().min(10_000).max(24 * 60 * 60_000),
  budgetUsd: z.number().min(0).max(1_000),
});
export type MissionContractInput = z.infer<typeof MissionContractInputSchema>;

const TaskDraftSchema = z.object({
  title: z.string().trim().min(1).max(300),
  acceptance: z.object({
    kind: z.enum(["test_passes", "command_succeeds", "file_exists", "manual"]),
    detail: z.string().max(1_000),
  }),
});
export type MissionTaskDraft = z.infer<typeof TaskDraftSchema>;

/** Creates the mission in `ready` and asks the model for a plan (editable before `start`). */
export const MissionPlanRequestSchema = z.object({
  workspaceId: entityId,
  conversationId: entityId.nullable(),
  goal: z.string().trim().min(1).max(20_000),
  mode: z.enum(WORK_MODES),
  modelId,
  /** null = defaults of the workspace profile (D11 budgets). */
  contract: MissionContractInputSchema.nullable(),
});
export type MissionPlanRequest = z.infer<typeof MissionPlanRequestSchema>;

export interface MissionPlanResult {
  mission: Mission;
  contract: MissionContract;
  tasks: MissionTask[];
  summary: string;
  /** Cost range with its assumptions; null bounds = unknown. */
  estimate: { minUsd: number | null; maxUsd: number | null; assumptions: string };
}

export const MissionStartRequestSchema = z.object({
  missionId: entityId,
  /** Plan as edited by the user (reordered/removed/added); null = keep the proposed plan. */
  tasks: z.array(TaskDraftSchema).max(50).nullable(),
  contract: MissionContractInputSchema,
});
export type MissionStartRequest = z.infer<typeof MissionStartRequestSchema>;

export const MissionIdRequestSchema = z.object({ missionId: entityId });
export type MissionIdRequest = z.infer<typeof MissionIdRequestSchema>;

export const MissionsListRequestSchema = z.object({
  workspaceId: entityId.nullable(),
  limit: z.int().min(1).max(200),
});
export type MissionsListRequest = z.infer<typeof MissionsListRequestSchema>;

export const MissionGetRequestSchema = z.object({
  missionId: entityId,
  /** Return only events with seq > afterSeq (0 = from the start). */
  afterSeq: z.int().min(0),
});
export type MissionGetRequest = z.infer<typeof MissionGetRequestSchema>;

export const ReviewDecideRequestSchema = z.object({
  missionId: entityId,
  decisions: z
    .array(
      z.object({
        path: RelativeEntryPathSchema,
        hunkIndex: z.int().min(0).nullable(),
        decision: z.enum(["kept", "reverted"]),
      }),
    )
    .min(1)
    .max(5_000),
});
export type ReviewDecideRequest = z.infer<typeof ReviewDecideRequestSchema>;

export interface ReviewResult {
  applied: ReviewDecision[];
  /** Reverts refused because the file changed since the mission wrote it (nothing overwritten). */
  conflicts: { path: RelativePath; hunkIndex: number | null }[];
}

