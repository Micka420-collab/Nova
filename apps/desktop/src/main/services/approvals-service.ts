// Approvals (S1, UX 7.2) in main. A tool call whose decision is `ask` waits here for the user:
// - `request()` persists a pending approval, emits `approval.requested` and returns a promise that
//   resolves ONLY when the user decides (no timeout, no auto-accept, no auto-refuse — UX 7.2 rule 5)
//   or when the mission stops (`cancelMission` → `denied`, row marked `expired`);
// - `decide()` (IPC approvals.decide) validates the scope: "for this mission / for this project" is
//   refused when the decision is not rememberable (S6); a remembered approval becomes a `policies`
//   row (source `user`) that the engine applies to later calls;
// - every step is recorded in the audit log.
//
// Events: `emit` receives `{ type: "approval.requested" | "approval.resolved", approval }`, the exact
// payloads of the MissionEvent variants of the same names. The missions lane appends them to the
// mission's event log, which pushes them on IPC_CHANNELS.missionsEvent (`nova:missions:event`).
import {
  isMcpToolName,
  redactSecrets,
  type Approval,
  type ApprovalDecideRequest,
  type ApprovalScope,
  type ApprovalsListRequest,
  type PermissionDecision,
  type PermissionRequest,
} from "@nova/shared";
import { effectiveOperation } from "@nova/permissions";
import type { ApprovalRecord, ApprovalRepo, PolicyRepo } from "@nova/storage";
import { ServiceError } from "../service-error";
import type { AuditService } from "./audit-service";

export type ApprovalOutcome = "approved" | "denied";

export type ApprovalEvent =
  | { type: "approval.requested"; approval: Approval }
  | { type: "approval.resolved"; approval: Approval };

export interface ApprovalsServiceDeps {
  approvals: ApprovalRepo;
  policies: PolicyRepo;
  audit: AuditService;
  emit(event: ApprovalEvent): void;
}

export interface ApprovalInput {
  request: PermissionRequest;
  /** The engine's `ask` decision (reason, rule and explanation are shown on the card). */
  decision: PermissionDecision;
  toolCallId: string | null;
}

/** What is stored in `approvals.request_json`: arguments are redacted, never file content. */
interface StoredApproval {
  request: PermissionRequest;
  decision: PermissionDecision;
}

function redactRequest(request: PermissionRequest): PermissionRequest {
  return request.argv === undefined ? request : { ...request, argv: request.argv.map(redactSecrets) };
}

function isStored(value: unknown): value is StoredApproval {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<StoredApproval>;
  return typeof candidate.request === "object" && candidate.request !== null && typeof candidate.decision === "object" && candidate.decision !== null;
}

function toApproval(record: ApprovalRecord): Approval | null {
  if (!isStored(record.request)) return null;
  return {
    id: record.id,
    request: record.request.request,
    decision: record.request.decision,
    toolCallId: record.toolCallId,
    status: record.status,
    scope: record.scope,
    createdAt: record.createdAt,
    decidedAt: record.decidedAt,
  };
}

export class ApprovalsService {
  /** Resolvers of the calls waiting for a decision, by approval id (process memory only). */
  private readonly waiting = new Map<string, (outcome: ApprovalOutcome) => void>();

  constructor(private readonly deps: ApprovalsServiceDeps) {}

  /** Pending approvals awaited in this process. */
  get pendingCount(): number {
    return this.waiting.size;
  }

  /**
   * Persists a pending approval and waits for the user's decision. Rejects only when the input is
   * not an `ask` decision or the approval cannot be stored/audited (the call must then not run).
   */
  request(input: ApprovalInput): Promise<ApprovalOutcome> {
    if (input.decision.decision !== "ask") {
      return Promise.reject(new ServiceError("internal", "Only an ask decision needs an approval"));
    }
    const stored: StoredApproval = { request: redactRequest(input.request), decision: input.decision };
    let approval: Approval | null;
    try {
      approval = toApproval(
        this.deps.approvals.insert({
          workspaceId: input.request.workspaceId,
          missionId: input.request.missionId,
          toolCallId: input.toolCallId,
          request: stored,
          ruleId: input.decision.ruleId,
          expiresAt: null,
        }),
      );
      if (approval === null) throw new ServiceError("internal", "Stored approval is unreadable");
      this.deps.audit.recordApproval(approval, "approval.requested");
    } catch (error) {
      return Promise.reject(error);
    }
    const created = approval;
    const outcome = new Promise<ApprovalOutcome>((resolve) => {
      this.waiting.set(created.id, resolve);
    });
    this.deps.emit({ type: "approval.requested", approval: created });
    return outcome;
  }

  async list(req: ApprovalsListRequest): Promise<Approval[]> {
    return this.deps.approvals
      .list({ workspaceId: req.workspaceId, missionId: req.missionId, status: req.status })
      .map(toApproval)
      .filter((approval): approval is Approval => approval !== null);
  }

  async decide(req: ApprovalDecideRequest): Promise<Approval> {
    const record = this.deps.approvals.get(req.approvalId);
    const current = record ? toApproval(record) : null;
    if (current === null) throw new ServiceError("not_found", "Approval not found");
    if (current.status !== "pending") throw new ServiceError("conflict", `Approval already ${current.status}`);
    const approve = req.decision === "approve";
    if (approve && req.scope !== "once" && !current.decision.rememberable) {
      throw new ServiceError("invalid_request", "This action can only be approved once");
    }
    if (approve && req.scope === "mission" && current.request.missionId === null) {
      throw new ServiceError("invalid_request", "No mission to remember this approval for");
    }

    const decided = this.deps.approvals.decide(
      current.id,
      approve ? { status: "approved", scope: req.scope } : { status: "denied" },
    );
    const approval = decided ? toApproval(decided) : null;
    if (approval === null) throw new ServiceError("conflict", "Approval already decided");
    if (approve && req.scope !== "once") this.remember(approval.request, req.scope);
    this.deps.audit.recordApproval(approval, "approval.decided");
    this.settle(approval, approve ? "approved" : "denied");
    return approval;
  }

  /** Mission stopped: its pending approvals expire and their waiting calls resolve `denied`. */
  cancelMission(missionId: string): Approval[] {
    return this.expire(this.deps.approvals.expireForMission(missionId));
  }

  /**
   * Startup: approvals left pending by a previous run have nobody awaiting them (the calls died with
   * the process); they are marked `expired`, never replayed. Returns the count.
   */
  expireOrphans(): number {
    return this.expire(this.deps.approvals.expireAllPending()).length;
  }

  private expire(records: ApprovalRecord[]): Approval[] {
    const expired = records.map(toApproval).filter((approval): approval is Approval => approval !== null);
    for (const approval of expired) {
      this.deps.audit.recordApproval(approval, "approval.expired");
      this.settle(approval, "denied");
    }
    return expired;
  }

  private settle(approval: Approval, outcome: ApprovalOutcome): void {
    const resolve = this.waiting.get(approval.id);
    this.waiting.delete(approval.id);
    this.deps.emit({ type: "approval.resolved", approval });
    resolve?.(outcome);
  }

  /**
   * "For this mission / for this project": same operation (and same host or MCP tool) is allowed
   * afterwards. Built-in tools are remembered per operation (write_file and edit_file both write),
   * paths are not narrowed (UX 7.2 rule 2: once per mission for the same operation).
   */
  private remember(request: PermissionRequest, scope: Exclude<ApprovalScope, "once">): void {
    const operation = effectiveOperation(request.tool, request.operation);
    // A network call without a host (web search) is remembered for that tool only.
    const toolSpecific = isMcpToolName(request.tool) || (operation === "network" && request.host === undefined);
    this.deps.policies.insert({
      workspaceId: request.workspaceId,
      missionId: scope === "mission" ? request.missionId : null,
      tool: toolSpecific ? request.tool : null,
      operation,
      pathGlob: null,
      host: operation === "network" ? (request.host ?? null) : null,
      decision: "allow",
      scope,
      source: "user",
      expiresAt: null,
    });
  }
}
