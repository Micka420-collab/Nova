// Permission engine contract (S1). The engine (@nova/permissions) runs in main, outside the model:
// every tool call is evaluated BEFORE execution; content (files, pages, MCP descriptions) never
// grants anything. Precedence: deny > mission contract > remembered approval > profile > default ask.
import { z } from "zod";
import type { RelativePath } from "./paths";
import type { OperationClass, ToolName } from "./tools";
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
export type ApprovalsListRequest = z.infer<typeof ApprovalsListRequestSchema>;
export type ApprovalDecideRequest = z.infer<typeof ApprovalDecideRequestSchema>;
export type PermissionsProfileRequest = z.infer<typeof PermissionsProfileRequestSchema>;
export type PermissionsSetProfileRequest = z.infer<typeof PermissionsSetProfileRequestSchema>;
