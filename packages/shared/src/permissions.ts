// Permission engine contract (S1). The engine (@nova/permissions) runs in main, outside the model:
// every tool call is evaluated BEFORE execution; content (files, pages, MCP descriptions) never
// grants anything. Precedence: deny > mission contract > remembered approval > profile > default ask.
import { z } from "zod";
import type { RelativePath } from "./paths";
import { OPERATION_CLASSES, type OperationClass, type ToolName } from "./tools";
import type { WorkMode } from "./missions";

export type PermissionDecisionKind = "allow" | "ask" | "deny";

/** Why the engine decided; drives the approval card's "which rule asked" line. */
export type PermissionReason =
  | "outside_workspace"
  | "excluded_path"
  | "mode_forbids"
  | "contract_allows"
  | "contract_forbids"
  | "remembered_approval"
  | "profile_allows"
  | "profile_asks"
  | "profile_forbids"
  /** Irreversible or dangerous (push, force, `rm -rf`, destructive MCP tool): ask every time. */
  | "always_ask"
  | "dangerous_command"
  /** Untrusted content entered the context; external effects fall back to ask (W5). */
  | "tainted_context"
  | "domain_policy"
  | "mcp_tool_policy"
  | "isolation_unavailable"
  | "default_ask";

export interface PermissionDecision {
  decision: PermissionDecisionKind;
  reason: PermissionReason;
  /** Rule that produced the decision (`policies.id`, or a built-in id like `builtin:outside-workspace`). */
  ruleId: string | null;
  /** Whether an `ask` may be answered "for this mission / always for this project" (false for S6). */
  rememberable: boolean;
  /** French explanation of the decision (approval card, audit log). Never contains file content. */
  explanation: string;
}

export interface PermissionRequest {
  workspaceId: string;
  missionId: string | null;
  tool: ToolName;
  operation: OperationClass;
  /** Relative path already resolved and contained by main (S2). */
  path?: RelativePath;
  /** Destination host for `network` operations (lowercase, no port). */
  host?: string;
  /** Command for `execute` operations. */
  argv?: string[];
  /** Mode of the mission; the engine refuses tools the mode does not allow (A12). */
  mode?: WorkMode;
  /** Untrusted content is in the context (W5). */
  tainted?: boolean;
}

export const PERMISSION_PROFILES = ["read_only", "assisted", "autonomous", "custom"] as const;
export type PermissionProfile = (typeof PERMISSION_PROFILES)[number];

/**
 * Honest isolation levels (S3). L0: separate process, scrubbed env, confined cwd, timeouts and caps
 * (always available). L1: OS sandbox (bubblewrap / sandbox-exec). L2: opt-in container.
 */
export type IsolationLevel = "L0" | "L1" | "L2";

export type ApprovalStatus = "pending" | "approved" | "denied" | "expired";
export type ApprovalScope = "once" | "mission" | "project";

export interface Approval {
  id: string;
  request: PermissionRequest;
  /** The engine's decision that required asking (reason and rule shown on the card). */
  decision: PermissionDecision;
  toolCallId: string | null;
  status: ApprovalStatus;
  /** Scope granted when approved; null while pending or when denied. */
  scope: ApprovalScope | null;
  createdAt: number;
  decidedAt: number | null;
}

/** A stored rule (`policies` table). Null fields match anything. */
export interface PermissionRule {
  id: string;
  workspaceId: string | null;
  missionId: string | null;
  tool: ToolName | null;
  operation: OperationClass | null;
  /** Glob on relative paths. */
  pathGlob: string | null;
  host: string | null;
  decision: PermissionDecisionKind;
  scope: ApprovalScope;
  source: "user" | "profile" | "contract" | "default";
  createdAt: number;
  expiresAt: number | null;
}

/**
 * Pushed on `approvals.onEvent` for every approval, inside a mission or not (the mission's own
 * event log carries the same payloads as `approval.requested` / `approval.resolved`).
 */
export type ApprovalEvent =
  | { type: "approval.requested"; approval: Approval }
  | { type: "approval.resolved"; approval: Approval };

export type AuditActor = "user" | "agent" | "system";

/** One row of the append-only audit log (S5). Targets are paths, hosts or redacted commands; never content. */
export interface AuditEntry {
  seq: number;
  at: number;
  workspaceId: string | null;
  missionId: string | null;
  toolCallId: string | null;
  actor: AuditActor;
  /** Dotted action: `permission.decision`, `approval.decided`, `tool.executed`, `permissions.rules_revoked`… */
  action: string;
  decision: PermissionDecisionKind | null;
  ruleId: string | null;
  target: string | null;
  /** Sizes, kinds, codes and costs only. */
  dataSummary: Record<string, string | number | boolean | null> | null;
  /** USD; null = none or unknown. */
  costUsd: number | null;
  outcome: string | null;
}

export interface PermissionProfileState {
  workspaceId: string;
  profile: PermissionProfile;
  /** Best isolation level really available on this machine. */
  isolationLevel: IsolationLevel;
  /**
   * D2: the Autonomous profile is allowed at L0, with an explicit banner. True when the profile is
   * `autonomous` and the level is L0.
   */
  showIsolationBanner: boolean;
}

export const ApprovalsListRequestSchema = z.object({
  workspaceId: z.uuid().nullable(),
  missionId: z.uuid().nullable(),
  status: z.enum(["pending", "approved", "denied", "expired"]).nullable(),
});
export const ApprovalDecideRequestSchema = z.object({
  approvalId: z.uuid(),
  decision: z.enum(["approve", "deny"]),
  /** Required for approve; must be `once` when the decision is not rememberable (enforced by main). */
  scope: z.enum(["once", "mission", "project"]),
});
export const PermissionsProfileRequestSchema = z.object({ workspaceId: z.uuid() });
export const PermissionsSetProfileRequestSchema = z.object({
  workspaceId: z.uuid(),
  profile: z.enum(PERMISSION_PROFILES),
});
export const AuditListRequestSchema = z.object({
  workspaceId: z.uuid().nullable(),
  missionId: z.uuid().nullable(),
  actor: z.enum(["user", "agent", "system"]).nullable(),
  /** Exact action, or a prefix ending with "." (`tool.`). */
  action: z
    .string()
    .regex(/^[a-z_]+(\.[a-z_]+)*\.?$/)
    .max(64)
    .nullable(),
  decision: z.enum(["allow", "ask", "deny"]).nullable(),
  /** `dataSummary.operation` ("tout ce qui est parti sur Internet" = network). */
  operation: z.enum(OPERATION_CLASSES).nullable(),
  /** Inclusive lower / exclusive upper bound on `at` (epoch ms). */
  since: z.int().min(0).nullable(),
  until: z.int().min(0).nullable(),
  /** Page backwards: rows with seq < beforeSeq. */
  beforeSeq: z.int().min(1).nullable(),
  limit: z.int().min(1).max(500),
});
export const PermissionRulesRequestSchema = z.object({ workspaceId: z.uuid() });
export const PermissionRevokeRequestSchema = z.object({
  workspaceId: z.uuid(),
  /** One remembered rule; null = every rule the user remembered for this project ("Tout révoquer"). */
  ruleId: z.uuid().nullable(),
});
export type ApprovalsListRequest = z.infer<typeof ApprovalsListRequestSchema>;
export type AuditListRequest = z.infer<typeof AuditListRequestSchema>;
export type PermissionRulesRequest = z.infer<typeof PermissionRulesRequestSchema>;
export type PermissionRevokeRequest = z.infer<typeof PermissionRevokeRequestSchema>;
export type ApprovalDecideRequest = z.infer<typeof ApprovalDecideRequestSchema>;
export type PermissionsProfileRequest = z.infer<typeof PermissionsProfileRequestSchema>;
export type PermissionsSetProfileRequest = z.infer<typeof PermissionsSetProfileRequestSchema>;
