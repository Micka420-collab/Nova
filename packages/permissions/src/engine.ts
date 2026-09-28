// Permission engine (S1): pure, synchronous, table-testable. Runs in main, outside the model.
//
// Tiers, first match wins:
// 1. stored deny rules (user, profile, contract, default);
// 2. built-in denials: path not canonical / outside the workspace (S2), excluded sensitive file (C8),
//    forbidden command (rm -rf /, curl | sh, sudo…), isolation level unavailable (S3);
// 3. mode (A12), mission contract (A13) and Lecture seule restrictions → deny;
// 4. always-ask: dangerous commands, external effects, `.git` internals (S6), and external effects
//    after untrusted content entered the context (W5) — never rememberable, not lowered by anything;
// 5. contract pre-approvals (hosts, web search, contract rules) → allow;
// 6. remembered approvals (user rules, scope mission / project) — only for rememberable requests;
// 7. profile defaults (custom profile: its stored rules first, then Assisté defaults);
// 8. default ask.
import {
  isCanonicalRelativePath,
  isMcpToolName,
  type IsolationLevel,
  type MissionContract,
  type OperationClass,
  type PermissionDecision,
  type PermissionDecisionKind,
  type PermissionProfile,
  type PermissionReason,
  type PermissionRequest,
  type PermissionRule,
  type WorkMode,
} from "@nova/shared";
import { classifyCommand, isKnownCommand, type CommandClassification } from "./commands";
import { explainDecision } from "./explain";
import { matchesGlob } from "./glob";
import { MODE_OPERATIONS, effectiveOperation } from "./modes";

export interface EvaluationContext {
  profile: PermissionProfile;
  /** Contract of the running mission; null for calls outside a mission. */
  contract: MissionContract | null;
  /** Stored rules relevant to the workspace (global + workspace + mission scope), any order. */
  rules: readonly PermissionRule[];
  /** Best isolation level available on this machine. */
  isolationLevel: IsolationLevel;
  /** Excluded-path matcher (C8: .env, keys, `.novaignore` exclusions). */
  isExcludedPath(path: string): boolean;
  /** Project commands treated as routine (detected test and build commands), as argv prefixes. */
  knownCommands?: readonly (readonly string[])[];
  /**
   * S2 on disk: the request's (canonical) path resolves outside the workspace through a symlink.
   * Computed by the caller with `resolveInWorkspace`; the engine stays pure and synchronous.
   */
  pathEscapes?: boolean;
  /** Evaluation time for rule expiry (defaults to Date.now()). */
  now?: number;
}

/** A decision plus what the UI and the audit log need to explain it. */
export interface EngineDecision extends PermissionDecision {
  /** Human explanation in French (approval card, audit viewer). */
  explanation: string;
  /** Operation actually evaluated (canonical for built-in tools). */
  operation: OperationClass;
}

const ISOLATION_RANK: Record<IsolationLevel, number> = { L0: 0, L1: 1, L2: 2 };
/** Operations whose effect leaves the machine or the restorable workspace (W5). */
const OUTBOUND: ReadonlySet<OperationClass> = new Set(["network", "external"]);

function hostMatches(pattern: string, host: string): boolean {
  if (pattern.startsWith("*.")) {
    const suffix = pattern.slice(1);
    return host.endsWith(suffix) && host.length > suffix.length;
  }
  return pattern === host;
}

function ruleMatches(rule: PermissionRule, request: PermissionRequest, operation: OperationClass, now: number): boolean {
  if (rule.expiresAt !== null && rule.expiresAt <= now) return false;
  if (rule.workspaceId !== null && rule.workspaceId !== request.workspaceId) return false;
  if (rule.missionId !== null && rule.missionId !== request.missionId) return false;
  if (rule.scope === "mission" && (rule.missionId === null || request.missionId === null)) return false;
  if (rule.tool !== null && rule.tool !== request.tool) return false;
  if (rule.operation !== null && rule.operation !== operation) return false;
  if (rule.pathGlob !== null && (request.path === undefined || !matchesGlob(request.path, rule.pathGlob))) return false;
  if (rule.host !== null && (request.host === undefined || !hostMatches(rule.host, request.host))) return false;
  return true;
}

function specificity(rule: PermissionRule): number {
  let score = 0;
  if (rule.missionId !== null) score += 16;
  if (rule.workspaceId !== null) score += 8;
  if (rule.tool !== null) score += 4;
  if (rule.pathGlob !== null || rule.host !== null) score += 2;
  if (rule.operation !== null) score += 1;
  return score;
}

/** Most specific rule; on a tie `ask` beats `allow` (the safer answer). */
function pick(rules: readonly PermissionRule[]): PermissionRule | null {
  let best: PermissionRule | null = null;
  for (const rule of rules) {
    if (!best) {
      best = rule;
      continue;
    }
    const diff = specificity(rule) - specificity(best);
    if (diff > 0 || (diff === 0 && rule.decision === "ask" && best.decision === "allow")) best = rule;
  }
  return best;
}

function denyReason(rule: PermissionRule): PermissionReason {
  if (rule.host !== null) return "domain_policy";
  if (rule.tool !== null && isMcpToolName(rule.tool)) return "mcp_tool_policy";
  if (rule.source === "contract") return "contract_forbids";
  return "profile_forbids";
}

function isGitInternals(path: string | undefined): boolean {
  return path !== undefined && (path === ".git" || path.startsWith(".git/"));
}

interface Facts {
  request: PermissionRequest;
  context: EvaluationContext;
  operation: OperationClass;
  command: CommandClassification;
  mode: WorkMode | null;
}

function decide(
  facts: Facts,
  decision: PermissionDecisionKind,
  reason: PermissionReason,
  ruleId: string | null,
  rememberable = false,
): EngineDecision {
  const { request, context, operation, command, mode } = facts;
  return {
    decision,
    reason,
    ruleId,
    // Only an `ask` can be remembered; the approval service refuses wider scopes otherwise.
    rememberable: decision === "ask" && rememberable,
    operation,
    explanation: explainDecision({
      decision,
      reason,
      operation,
      path: request.path ?? null,
      host: request.host ?? null,
      mode,
      profile: context.profile,
      commandLabel: command.label,
    }),
  };
}

function modeDecision(facts: Facts): EngineDecision | null {
  const { mode, operation, request, context } = facts;
  if (mode === null) return null;
  const contract = context.contract;
  const forbid = (): EngineDecision => decide(facts, "deny", "mode_forbids", `mode:${mode}`);
  switch (MODE_OPERATIONS[mode][operation]) {
    case "yes":
      return null;
    case "no":
      return forbid();
    case "web":
      return request.tool === "web_search" && contract?.webSearch === true ? null : forbid();
    case "contract": {
      const allowed =
        contract !== null &&
        (contract.allowedOperations.includes("network") || (request.tool === "web_search" && contract.webSearch));
      return allowed ? null : forbid();
    }
    case "tests": {
      const routine =
        request.tool === "run_tests" ||
        (request.argv !== undefined && isKnownCommand(request.argv, context.knownCommands ?? []));
      return routine ? null : forbid();
    }
  }
}

function contractRestriction(facts: Facts): EngineDecision | null {
  const { context, operation, request } = facts;
  const contract = context.contract;
  if (contract === null) return null;
  if (request.tool === "web_search") {
    return contract.webSearch ? null : decide(facts, "deny", "contract_forbids", "contract:web-search");
  }
  if (!contract.allowedOperations.includes(operation)) {
    return decide(facts, "deny", "contract_forbids", "contract:operations");
  }
  return null;
}

function contractHostAllows(contract: MissionContract | null, host: string | undefined): boolean {
  return contract !== null && host !== undefined && contract.allowedHosts.some((pattern) => hostMatches(pattern, host));
}

function alwaysAsk(facts: Facts): EngineDecision | null {
  const { request, operation, command, context } = facts;
  if (command.risk === "dangerous") return decide(facts, "ask", "always_ask", "builtin:dangerous-command");
  if (operation === "external") return decide(facts, "ask", "always_ask", "builtin:external-effect");
  if ((operation === "write" || operation === "delete") && isGitInternals(request.path)) {
    return decide(facts, "ask", "always_ask", "builtin:git-internals");
  }
  // W5: after untrusted content, only hosts the contract names explicitly stay automatic.
  if (request.tainted === true && OUTBOUND.has(operation) && !contractHostAllows(context.contract, request.host)) {
    return decide(facts, "ask", "tainted_context", "builtin:tainted-context");
  }
  return null;
}

function contractAllows(facts: Facts, rules: readonly PermissionRule[]): EngineDecision | null {
  const { request, context } = facts;
  const contract = context.contract;
  if (contract !== null && request.tool === "web_search" && contract.webSearch) {
    return decide(facts, "allow", "contract_allows", "contract:web-search");
  }
  if (facts.operation === "network" && contractHostAllows(contract, request.host)) {
    return decide(facts, "allow", "contract_allows", "contract:hosts");
  }
  const rule = pick(rules.filter((candidate) => candidate.source === "contract"));
  if (rule === null) return null;
  return rule.decision === "allow"
    ? decide(facts, "allow", "contract_allows", rule.id)
    : decide(facts, "ask", "profile_asks", rule.id, true);
}

/** Whether "for this mission / for this project" may be offered and remembered (S6). */
function rememberableRequest(facts: Facts): boolean {
  const { operation, command, request } = facts;
  if (command.risk !== "normal" || request.tainted === true) return false;
  // Deletions ask every time; rules carry no argv, so remembering a command would allow them all.
  return operation === "read" || operation === "write" || operation === "network" || operation === "git_mutation";
}

function profileDefaults(facts: Facts, profile: Exclude<PermissionProfile, "custom">, ruleId: string): EngineDecision {
  const { operation, request, context } = facts;
  const rememberable = rememberableRequest(facts);
  const allow = (): EngineDecision => decide(facts, "allow", "profile_allows", ruleId);
  const ask = (canRemember = rememberable): EngineDecision => decide(facts, "ask", "profile_asks", ruleId, canRemember);
  if (operation === "read") return allow();
  if (operation === "network") {
    // Hosts the contract names were allowed in tier 5; anything else is asked, whatever the profile.
    return decide(facts, "ask", "domain_policy", ruleId, rememberable);
  }
  if (profile === "autonomous") return allow();
  // Assisté.
  if (operation === "execute") {
    const routine =
      request.tool === "run_tests" ||
      (request.argv !== undefined && isKnownCommand(request.argv, context.knownCommands ?? []));
    return routine ? allow() : ask(false);
  }
  if (operation === "delete") return ask(false);
  return ask();
}

export function evaluate(request: PermissionRequest, context: EvaluationContext): EngineDecision {
  const operation = effectiveOperation(request.tool, request.operation);
  const facts: Facts = {
    request,
    context,
    operation,
    command: operation === "execute" && request.argv !== undefined ? classifyCommand(request.argv) : { risk: "normal", label: null },
    mode: request.mode ?? context.contract?.mode ?? null,
  };
  const now = context.now ?? Date.now();
  const rules = context.rules.filter((rule) => ruleMatches(rule, request, operation, now));

  // 1. Stored deny rules.
  const denied = pick(rules.filter((rule) => rule.decision === "deny"));
  if (denied !== null) return decide(facts, "deny", denyReason(denied), denied.id);

  // 2. Built-in denials.
  if (request.path !== undefined && (!isCanonicalRelativePath(request.path) || context.pathEscapes === true)) {
    return decide(facts, "deny", "outside_workspace", "builtin:outside-workspace");
  }
  if (request.path !== undefined && context.isExcludedPath(request.path)) {
    return decide(facts, "deny", "excluded_path", "builtin:excluded-path");
  }
  if (facts.command.risk === "forbidden") return decide(facts, "deny", "dangerous_command", "builtin:forbidden-command");
  if (
    operation === "execute" &&
    context.contract !== null &&
    ISOLATION_RANK[context.contract.isolationLevel] > ISOLATION_RANK[context.isolationLevel]
  ) {
    return decide(facts, "deny", "isolation_unavailable", "builtin:isolation");
  }

  // 3. Mode and contract restrictions.
  const restricted = modeDecision(facts) ?? contractRestriction(facts);
  if (restricted !== null) return restricted;
  // Lecture seule restricts like a contract: nothing below may turn a change into an allow or ask.
  if (context.profile === "read_only" && operation !== "read" && operation !== "network") {
    return decide(facts, "deny", "profile_forbids", "profile:read_only");
  }

  // 4. Always ask.
  const forced = alwaysAsk(facts);
  if (forced !== null) return forced;

  // 5. Contract pre-approvals.
  const contracted = contractAllows(facts, rules);
  if (contracted !== null) return contracted;

  // 6. Remembered approvals.
  const rememberable = rememberableRequest(facts);
  const remembered = pick(rules.filter((rule) => rule.source === "user"));
  if (remembered !== null && (remembered.decision === "ask" || rememberable)) {
    return remembered.decision === "allow"
      ? decide(facts, "allow", "remembered_approval", remembered.id)
      : decide(facts, "ask", "profile_asks", remembered.id, rememberable);
  }

  // 7. Profile.
  if (context.profile === "custom") {
    const custom = pick(rules.filter((rule) => rule.source === "profile" || rule.source === "default"));
    if (custom !== null) {
      return custom.decision === "allow"
        ? decide(facts, "allow", "profile_allows", custom.id)
        : decide(facts, "ask", "profile_asks", custom.id, rememberable);
    }
    return profileDefaults(facts, "assisted", "profile:custom");
  }
  return profileDefaults(facts, context.profile, `profile:${context.profile}`);
}

/** Engine object for dependency injection (`PermissionEngine`). */
export const permissionEngine = { evaluate };
