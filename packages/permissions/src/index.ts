// @nova/permissions — permission engine (S1), runs in MAIN only (paths.ts and isolation.ts use node:fs).
//
// - `evaluate` is pure and synchronous over an `EvaluationContext` snapshot (rules, profile,
//   contract, isolation, taint): table-driven tests cover it without Electron or SQLite.
// - Tiers (engine.ts header): deny rules > built-in denials > mode/contract restrictions > always-ask
//   > contract pre-approvals > remembered approvals > profile > default `ask`.
// - `external` operations and dangerous commands (push, force, reset --hard, rm -rf…) are never
//   `rememberable` (S6). Untrusted content in context (`tainted`) turns outbound effects into `ask`
//   unless the contract names the host (W5).
// - D2: the `autonomous` profile is allowed at L0; the UI shows a banner (PermissionProfileState).
// - Every decision is recorded in audit_log by the main permissions service (never skipped).
import type {
  ApprovalScope,
  PermissionDecision,
  PermissionRequest,
  ToolName,
  WorkMode,
} from "@nova/shared";
import type { EvaluationContext } from "./engine";

export { evaluate, permissionEngine, type EngineDecision, type EvaluationContext } from "./engine";
export { classifyCommand, isKnownCommand, type CommandClassification, type CommandRisk } from "./commands";
export { DEFAULT_EXCLUDED_PATTERNS, createExcludedPathMatcher } from "./excluded";
export { explainDecision, MODE_LABELS, OPERATION_LABELS, PROFILE_LABELS, type ExplanationFacts } from "./explain";
export { globToRegExp, matchesGlob } from "./glob";
export {
  ISOLATION_DESCRIPTIONS,
  detectIsolation,
  type DetectIsolationOptions,
  type IsolationCandidate,
  type IsolationReport,
} from "./isolation";
export {
  BUILTIN_TOOL_OPERATIONS,
  MODE_OPERATIONS,
  MODE_TOOLS,
  effectiveOperation,
  modeBuiltinTools,
  type ModeAllowance,
} from "./modes";
export { resolveInWorkspace, type ResolveFailure, type ResolvedPath } from "./paths";

export interface PermissionEngine {
  evaluate(request: PermissionRequest, context: EvaluationContext): PermissionDecision;
}

/** Tools a work mode may use (A12); the engine denies any other operation with reason `mode_forbids`. */
export type ModeToolPolicy = Readonly<Record<WorkMode, ReadonlySet<ToolName>>>;

/** What remembering an approval creates (`policies` row), decided by the approval service in main. */
export interface RememberedApproval {
  request: PermissionRequest;
  scope: Exclude<ApprovalScope, "once">;
}
