// @nova/permissions — permission engine (S1), runs in MAIN only.
//
// Contract for the feature implementation:
// - `evaluate` is pure and synchronous over an `EvaluationContext` snapshot (rules, profile,
//   contract, isolation, taint): table-driven tests cover it without Electron or SQLite.
// - Precedence: deny rules > mission contract > remembered approvals > profile > default `ask`.
// - Built-in denials are not overridable: outside workspace / excluded path (S2, C8), a mode that does
//   not include the tool (A12), an operation needing an isolation level that is unavailable (S3).
// - `external` operations and `always_ask` commands (push, force, reset --hard, rm -rf…) are never
//   `rememberable` (S6). Untrusted content in context (`tainted`) turns external effects into `ask`
//   unless the contract explicitly allows them (W5).
// - D2: the `autonomous` profile is allowed at L0; the UI shows a banner (PermissionProfileState).
// Every decision is recorded (tool.permission event + audit_log) by the caller, never skipped.
import type {
  ApprovalScope,
  IsolationLevel,
  MissionContract,
  PermissionDecision,
  PermissionProfile,
  PermissionRequest,
  PermissionRule,
  WorkMode,
} from "@nova/shared";

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
}

export interface PermissionEngine {
  evaluate(request: PermissionRequest, context: EvaluationContext): PermissionDecision;
}

/** Tools a work mode may use (A12); the engine denies any other tool with reason `mode_forbids`. */
export type ModeToolPolicy = Readonly<Record<WorkMode, ReadonlySet<string>>>;

/** What remembering an approval creates (`policies` row), decided by the approval service in main. */
export interface RememberedApproval {
  request: PermissionRequest;
  scope: Exclude<ApprovalScope, "once">;
}
