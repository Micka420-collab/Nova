// Audit trail service (S5): records every permission decision, approval and tool execution summary
// in the append-only `audit_log`. Content is never recorded: targets are relative paths, hosts or
// redacted command lines; summaries hold sizes, kinds and costs only.
//
// Failure policy: `record*` throws when the row cannot be written. The permissions service lets it
// propagate so the tool call does not run (no execution without a recorded decision, J2-A exit
// criteria); tool execution summaries are recorded after the fact by the caller.
import {
  redactSecrets,
  type Approval,
  type OperationClass,
  type PermissionDecision,
  type PermissionRequest,
  type ToolName,
} from "@nova/shared";
import type { AuditDataSummary, AuditFilter, AuditRecord, AuditRepo } from "@nova/storage";

/** S5 default retention ("rétention réglable"): the caller may pass the user's setting instead. */
export const DEFAULT_AUDIT_RETENTION_MS = 90 * 24 * 60 * 60_000;
const TARGET_MAX = 300;
const OUTCOME_MAX = 500;

export interface AuditServiceDeps {
  repo: AuditRepo;
  now?: () => number;
  retentionMs?: number;
}

export interface ToolExecutionSummary {
  workspaceId: string;
  missionId: string | null;
  toolCallId: string | null;
  tool: ToolName;
  operation: OperationClass;
  /** Relative path, host, or null. For commands pass `argv` instead. */
  target: string | null;
  argv?: readonly string[] | null;
  state: "succeeded" | "failed" | "cancelled" | "denied";
  /** Bytes that left the machine (network, MCP); null = none or unknown. */
  bytesSent?: number | null;
  bytesReceived?: number | null;
  /** Bytes written to the workspace. */
  bytesWritten?: number | null;
  exitCode?: number | null;
  durationMs?: number | null;
  /** USD; null = none or unknown. */
  costUsd?: number | null;
}

function bounded(text: string, max: number): string {
  const clean = redactSecrets(text);
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

/** Path, host or redacted command line; never file content. */
export function auditTarget(request: Pick<PermissionRequest, "path" | "host" | "argv" | "tool">): string {
  if (request.path !== undefined) return request.path === "" ? "." : request.path;
  if (request.host !== undefined) return request.host;
  if (request.argv !== undefined) return bounded(request.argv.join(" "), TARGET_MAX);
  return request.tool;
}

function compact(summary: Record<string, string | number | boolean | null | undefined>): AuditDataSummary {
  const out: AuditDataSummary = {};
  for (const [key, value] of Object.entries(summary)) if (value !== undefined) out[key] = value;
  return out;
}

export class AuditService {
  private readonly now: () => number;
  private readonly retentionMs: number;

  constructor(private readonly deps: AuditServiceDeps) {
    this.now = deps.now ?? Date.now;
    this.retentionMs = deps.retentionMs ?? DEFAULT_AUDIT_RETENTION_MS;
  }

  recordDecision(
    request: PermissionRequest,
    decision: PermissionDecision & { explanation?: string; operation?: OperationClass },
    toolCallId: string | null,
  ): AuditRecord {
    return this.deps.repo.append({
      workspaceId: request.workspaceId,
      missionId: request.missionId,
      toolCallId,
      actor: "agent",
      action: "permission.decision",
      decision: decision.decision,
      ruleId: decision.ruleId,
      target: auditTarget(request),
      dataSummary: compact({
        tool: request.tool,
        operation: decision.operation ?? request.operation,
        reason: decision.reason,
        mode: request.mode ?? null,
        tainted: request.tainted === true,
      }),
      cost: null,
      outcome: decision.explanation === undefined ? null : bounded(decision.explanation, OUTCOME_MAX),
    });
  }

  recordApproval(approval: Approval, action: "approval.requested" | "approval.decided" | "approval.expired"): AuditRecord {
    const request = approval.request;
    return this.deps.repo.append({
      workspaceId: request.workspaceId,
      missionId: request.missionId,
      toolCallId: approval.toolCallId,
      actor: action === "approval.decided" ? "user" : "system",
      action,
      decision: action === "approval.requested" ? "ask" : approval.status === "approved" ? "allow" : "deny",
      ruleId: approval.decision.ruleId,
      target: auditTarget(request),
      dataSummary: compact({
        approvalId: approval.id,
        tool: request.tool,
        operation: request.operation,
        status: approval.status,
        scope: approval.scope,
      }),
      cost: null,
      outcome: approval.status,
    });
  }

  recordToolExecution(summary: ToolExecutionSummary): AuditRecord {
    const target =
      summary.argv !== undefined && summary.argv !== null
        ? bounded(summary.argv.join(" "), TARGET_MAX)
        : summary.target === null
          ? null
          : bounded(summary.target, TARGET_MAX);
    return this.deps.repo.append({
      workspaceId: summary.workspaceId,
      missionId: summary.missionId,
      toolCallId: summary.toolCallId,
      actor: "agent",
      action: "tool.executed",
      decision: null,
      ruleId: null,
      target,
      dataSummary: compact({
        tool: summary.tool,
        operation: summary.operation,
        bytesSent: summary.bytesSent,
        bytesReceived: summary.bytesReceived,
        bytesWritten: summary.bytesWritten,
        exitCode: summary.exitCode,
        durationMs: summary.durationMs,
      }),
      cost: summary.costUsd ?? null,
      outcome: summary.state,
    });
  }

  /** A user-initiated settings change (profile, revocation). */
  recordUserAction(workspaceId: string | null, action: string, target: string | null, summary: AuditDataSummary): AuditRecord {
    return this.deps.repo.append({
      workspaceId,
      missionId: null,
      toolCallId: null,
      actor: "user",
      action,
      decision: null,
      ruleId: null,
      target,
      dataSummary: summary,
      cost: null,
      outcome: null,
    });
  }

  list(filter: AuditFilter): AuditRecord[] {
    return this.deps.repo.list(filter);
  }

  /** Deletes rows older than the retention; call at startup and daily. Returns the count. */
  purgeExpired(): number {
    return this.deps.repo.purgeBefore(this.now() - this.retentionMs);
  }
}
