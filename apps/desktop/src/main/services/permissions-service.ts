// Permissions service (S1) in main: builds the engine's context from storage and records every
// decision in the audit log before returning it. Other lanes call `evaluate` BEFORE any tool effect;
// only `allow` lets the tool run, `ask` goes through the approvals service, `deny` is final.
//
// The mission contract is the authority inside a mission: its profile replaces the workspace
// profile for the mission's calls (the contract was prefilled from it and shown to the user).
import {
  type IsolationLevel,
  type MissionContract,
  type PermissionProfileState,
  type PermissionRequest,
  type PermissionRevokeRequest,
  type PermissionRule,
  type PermissionRulesRequest,
  type PermissionsProfileRequest,
  type PermissionsSetProfileRequest,
} from "@nova/shared";
import { createExcludedPathMatcher, evaluate, resolveInWorkspace, type EngineDecision, type IsolationReport } from "@nova/permissions";
import type { PolicyRepo } from "@nova/storage";
import { ServiceError } from "../service-error";
import type { AuditService } from "./audit-service";

export interface PermissionsServiceDeps {
  policies: PolicyRepo;
  audit: AuditService;
  /** Result of `detectIsolation()` at startup (S3): the level NOVA really enforces. */
  isolation: Pick<IsolationReport, "level">;
  /** Contract of a mission (missions lane); null when unknown. */
  contractOf(missionId: string): MissionContract | null;
  /**
   * Routine project commands (detected test and build argv, workspace facts). Default: none, so
   * every command is asked in Assisté.
   */
  knownCommands?(workspaceId: string): readonly (readonly string[])[];
  /** Extra exclusions of the workspace (`.novaignore`); defaults only when absent. */
  excludedPatterns?(workspaceId: string): readonly string[];
  /** Absolute root of a workspace, for the on-disk S2 check of `evaluateOnDisk`. */
  rootOf?(workspaceId: string): Promise<string | null>;
  /**
   * J2-B L5: root a mission works in when it is not its workspace's (a writing sub-mission's
   * worktree); null = the workspace root. Paths are resolved (S2) where the effect happens.
   */
  missionRootOf?(missionId: string): Promise<string | null>;
  now?: () => number;
}

export interface EvaluateOptions {
  /** Tool call being decided (`tool_calls.id`), recorded with the decision. */
  toolCallId?: string | null;
  /** The path resolves outside the workspace on disk (see `evaluateOnDisk`). */
  pathEscapes?: boolean;
}

export class PermissionsService {
  private readonly now: () => number;

  constructor(private readonly deps: PermissionsServiceDeps) {
    this.now = deps.now ?? Date.now;
  }

  get isolationLevel(): IsolationLevel {
    return this.deps.isolation.level;
  }

  private state(workspaceId: string): PermissionProfileState {
    const profile = this.deps.policies.getProfile(workspaceId);
    if (profile === null) throw new ServiceError("not_found", "Workspace not found");
    const isolationLevel = this.deps.isolation.level;
    return {
      workspaceId,
      profile,
      isolationLevel,
      // D2: Autonomous is allowed at L0, with an explicit banner.
      showIsolationBanner: profile === "autonomous" && isolationLevel === "L0",
    };
  }

  async getProfile(req: PermissionsProfileRequest): Promise<PermissionProfileState> {
    return this.state(req.workspaceId);
  }

  async setProfile(req: PermissionsSetProfileRequest): Promise<PermissionProfileState> {
    const previous = this.state(req.workspaceId).profile;
    if (!this.deps.policies.setProfile(req.workspaceId, req.profile)) {
      throw new ServiceError("not_found", "Workspace not found");
    }
    this.deps.audit.recordUserAction(req.workspaceId, "permissions.profile_changed", null, {
      from: previous,
      to: req.profile,
    });
    return this.state(req.workspaceId);
  }

  /** Rules the user remembered ("pour cette mission / ce projet"), newest first. */
  async listRules(req: PermissionRulesRequest): Promise<PermissionRule[]> {
    this.state(req.workspaceId);
    return this.deps.policies
      .listForWorkspace(req.workspaceId)
      .filter((rule) => rule.source === "user")
      .toSorted((a, b) => b.createdAt - a.createdAt);
  }

  /** Revokes one remembered rule, or all of them ("Tout révoquer"); audited. Returns the count. */
  async revokeRules(req: PermissionRevokeRequest): Promise<number> {
    this.state(req.workspaceId);
    let count: number;
    if (req.ruleId === null) {
      count = this.deps.policies.revokeUserRules(req.workspaceId);
    } else {
      const rule = this.deps.policies.listForWorkspace(req.workspaceId).find((item) => item.id === req.ruleId);
      if (!rule || rule.source !== "user") throw new ServiceError("not_found", "Rule not found");
      count = this.deps.policies.delete(rule.id) ? 1 : 0;
    }
    this.deps.audit.recordUserAction(req.workspaceId, "permissions.rules_revoked", req.ruleId, { count });
    return count;
  }

  /**
   * Decides a call and records the decision (audit_log) before returning it. Throws (and nothing
   * may run) when the workspace is unknown, the contract belongs to another workspace, or the
   * audit row cannot be written.
   */
  evaluate(request: PermissionRequest, options: EvaluateOptions = {}): EngineDecision {
    const workspaceProfile = this.deps.policies.getProfile(request.workspaceId);
    if (workspaceProfile === null) throw new ServiceError("not_found", "Workspace not found");
    const contract = request.missionId === null ? null : this.deps.contractOf(request.missionId);
    if (contract !== null && contract.workspaceId !== request.workspaceId) {
      throw new ServiceError("invalid_request", "Mission contract belongs to another workspace");
    }
    const now = this.now();
    const decision = evaluate(request, {
      profile: contract?.profile ?? workspaceProfile,
      contract,
      rules: this.deps.policies.listForEvaluation(request.workspaceId, request.missionId, now),
      isolationLevel: this.deps.isolation.level,
      isExcludedPath: createExcludedPathMatcher(this.deps.excludedPatterns?.(request.workspaceId) ?? []),
      knownCommands: this.deps.knownCommands?.(request.workspaceId) ?? [],
      pathEscapes: options.pathEscapes === true,
      now,
    });
    this.deps.audit.recordDecision(request, decision, options.toolCallId ?? null);
    return decision;
  }

  /**
   * `evaluate` for agent tools, whose paths come from the model: a canonical path that a symlink
   * (even dangling) leads outside the workspace is refused HERE as `outside_workspace` and audited
   * so, instead of being allowed and only stopped later by the file API. A path a symlink leads
   * elsewhere INSIDE the workspace is decided at its real target: rules and C8 exclusions judge
   * what the call touches (`notes.txt -> .env`, `docs/ci -> ../.github/workflows`), not its name.
   */
  async evaluateOnDisk(request: PermissionRequest, options: EvaluateOptions = {}): Promise<EngineDecision> {
    // A writing sub-mission acts in its worktree: its paths are checked (S2) there.
    const missionRoot = request.path !== undefined && request.missionId ? await this.deps.missionRootOf?.(request.missionId) : null;
    return this.evaluateAtRoot(request, options, missionRoot ?? null);
  }

  /** Like `evaluateOnDisk`, always against the project root (a sub-mission's integration writes there). */
  async evaluateInProject(request: PermissionRequest, options: EvaluateOptions = {}): Promise<EngineDecision> {
    return this.evaluateAtRoot(request, options, null);
  }

  private async evaluateAtRoot(request: PermissionRequest, options: EvaluateOptions, missionRoot: string | null): Promise<EngineDecision> {
    const root = request.path === undefined ? null : (missionRoot ?? (await this.deps.rootOf?.(request.workspaceId)));
    const resolved = root && request.path !== undefined ? await resolveInWorkspace(root, request.path) : null;
    const target = resolved?.ok === true ? { ...request, path: resolved.relativePath } : request;
    return this.evaluate(target, { ...options, pathEscapes: resolved?.ok === false && resolved.reason === "outside_workspace" });
  }
}
