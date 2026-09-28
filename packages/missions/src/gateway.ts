// Tool gateway (main side, S1/A12/A10): the only path from a model tool call to an effect.
// Order per call: journal `tool.requested` → parse + validate arguments (invalid → error result,
// never executed) → mode check (`mode_forbids`) → `permissions.evaluate` for every target and the
// owner's policy (web domain policy, MCP tool permission), strictest wins → `ask` waits for the
// approval → checkpoint before writes → execute → journal `tool.finished` (exactly once, whatever
// happens) → proof for tests/commands.
import {
  isToolName,
  redactSecrets,
  type Approval,
  type Checkpoint,
  type MissionContract,
  type PermissionDecision,
  type PermissionRequest,
  type Proof,
  type RelativePath,
  type ToolCallSummary,
  type ToolDisplay,
  type ToolName,
  type ToolResult,
  type WorkMode,
} from "@nova/shared";
import {
  errorResult,
  toToolFailure,
  type ExecutedToolResult,
  type OwnerPolicy,
  type ToolExecutor,
  type ToolPermissionFacts,
  type ToolRegistry,
} from "@nova/tools";
import type { MissionEventInput, ToolGateway, ToolRunRequest } from "./index";

export interface PermissionGate {
  /** L1 `PermissionsService.evaluate`: records the decision (audit) before returning it; may throw (then nothing runs). */
  evaluate(request: PermissionRequest, options: { toolCallId: string }): PermissionDecision | Promise<PermissionDecision>;
}

export interface ApprovalGate {
  /**
   * Creates the pending approval, reports it through `onPending`, and resolves with the decided
   * approval. An aborted signal must resolve it (`expired` or `denied`), never leave it hanging.
   */
  request(
    input: { request: PermissionRequest; decision: PermissionDecision; toolCallId: string; missionId: string },
    options: { signal: AbortSignal; onPending(approval: Approval): void },
  ): Promise<Approval>;
}

export interface CheckpointGate {
  /** Creates the (empty) restore point of one tool call; the file API snapshots each file into it (A10). */
  create(input: { workspaceId: string; missionId: string; label: string; reason: "tool_write" }): Checkpoint;
}

/** Per-mission state the gateway needs (built by the controller when the mission starts). */
export interface MissionToolContext {
  workspaceId: string;
  missionId: string;
  mode: WorkMode;
  contract: MissionContract;
  /** Mode tool set (A12): anything else is refused before execution. */
  allowedTools: ReadonlySet<ToolName>;
  registry: ToolRegistry;
  seenVersions: Map<RelativePath, string>;
  /** Untrusted content entered the context (W5); set by the gateway, read by the engine. */
  tainted: boolean;
  /**
   * Aborted when main ends the mission (stop, runtime gone, any terminal event): pending approvals
   * expire and running tools stop even when the runtime never cancels its call.
   */
  signal: AbortSignal;
}

/** What L1 `AuditService.recordToolExecution` takes (S5): no content, argv redacted by the sink. */
export interface ToolExecutionAudit {
  workspaceId: string;
  missionId: string;
  toolCallId: string;
  tool: ToolName;
  operation: ToolCallSummary["operation"];
  target: string | null;
  argv: string[] | null;
  state: "succeeded" | "failed" | "cancelled" | "denied";
  exitCode: number | null;
  durationMs: number;
}

export interface ToolGatewayDeps {
  context(missionId: string): MissionToolContext | null;
  permissions: PermissionGate;
  approvals: ApprovalGate;
  checkpoints: CheckpointGate | null;
  journal: { append(event: MissionEventInput): unknown };
  toolCalls: {
    insert(input: { id: string; missionId: string; tool: string; operation: ToolCallSummary["operation"]; arguments: unknown }): unknown;
    setDecision(id: string, decision: PermissionDecision["decision"], ruleId: string | null): void;
    markRunning(id: string): void;
    finish(id: string, state: "denied" | "succeeded" | "failed" | "cancelled", outcome: { exitCode: number | null; resultSummary: string | null }): void;
  };
  proofs: { insert(input: Omit<Proof, "id" | "createdAt">): Proof };
  /** Audit trail of executions (S5); engine decisions are audited by the permission gate itself. */
  audit?: (entry: ToolExecutionAudit) => void;
  /**
   * S5: records a decision the permission gate never saw (mode refusal) or did not make (an owner
   * rule won the merge), so the audit log holds the rule that actually decided. Throws: nothing runs.
   */
  auditDecision?: (request: PermissionRequest, decision: PermissionDecision, toolCallId: string) => void;
  now?: () => number;
}

const RANK: Record<PermissionDecision["decision"], number> = { allow: 0, ask: 1, deny: 2 };

/** Owner policies (web domain policy, MCP tool setting) explained on the card and in the audit log. */
const OWNER_EXPLANATIONS: Record<OwnerPolicy["reason"], Record<OwnerPolicy["decision"], string>> = {
  domain_policy: {
    ask: "La politique Internet de ce projet demande ton accord pour ce site.",
    deny: "La politique Internet de ce projet refuse ce site.",
  },
  mcp_tool_policy: {
    ask: "Cet outil MCP est réglé sur « Demander » : NOVA te demande à chaque appel.",
    deny: "Cet outil MCP est bloqué pour ce projet.",
  },
};

/**
 * deny > ask > allow; among equals the first one (its rule is the one shown). An `ask` is
 * rememberable only when every `ask` is: remembering answers the engine's question, never an owner
 * rule that asks on each call (S6), so offering it would promise what the next call breaks.
 */
export function strictestDecision(decisions: readonly PermissionDecision[]): PermissionDecision {
  let result: PermissionDecision | null = null;
  for (const decision of decisions) if (!result || RANK[decision.decision] > RANK[result.decision]) result = decision;
  if (result?.decision === "ask" && result.rememberable && decisions.some((decision) => decision.decision === "ask" && !decision.rememberable)) {
    return { ...result, rememberable: false };
  }
  return (
    result ?? {
      decision: "ask",
      reason: "default_ask",
      ruleId: null,
      rememberable: true,
      explanation: "Aucune règle ne couvre cette action : NOVA te demande ton accord.",
    }
  );
}

function preview(raw: string): string {
  const text = redactSecrets(raw);
  return text.length > 2_000 ? `${text.slice(0, 2_000)}…` : text;
}

/**
 * What is journaled, stored as a proof and pushed to the renderer never holds a secret: a command
 * line or its output may carry a token (`-H "Authorization: Bearer …"`). Idempotent.
 */
function redactDisplay(display: ToolDisplay): ToolDisplay {
  switch (display.kind) {
    case "command":
      return { ...display, argv: display.argv.map(redactSecrets), outputTail: redactSecrets(display.outputTail) };
    case "error":
      return { ...display, message: redactSecrets(display.message) };
    case "mcp":
      return { ...display, text: redactSecrets(display.text) };
    default:
      return display;
  }
}

function finishedState(result: ToolResult): "succeeded" | "failed" | "cancelled" {
  if (result.ok) return "succeeded";
  return result.display.kind === "error" && result.display.code === "cancelled" ? "cancelled" : "failed";
}

function exitCodeOf(display: ToolDisplay): number | null {
  return display.kind === "command" || display.kind === "tests" ? display.exitCode : null;
}

function summaryOf(result: ToolResult): string {
  const display = result.display;
  switch (display.kind) {
    case "error":
      return `${display.code}: ${display.message}`;
    case "tests": {
      // Counts the runner did not report are left out, never shown as "?".
      const passed = display.passed === null ? null : `${display.passed} réussis`;
      const failed = display.failed === null ? null : `${display.failed} échecs`;
      return [passed, failed, `code ${display.exitCode === null ? "inconnu" : String(display.exitCode)}`].filter(Boolean).join(", ");
    }
    case "command":
      return `code ${String(display.exitCode)}`;
    case "file_change":
      return `${display.change} ${display.path}`;
    default:
      return display.kind;
  }
}

const REFUSAL_HINT: Partial<Record<PermissionDecision["reason"], string>> = {
  mode_forbids: "this work mode does not allow this tool; do not retry it, work with the tools you have or tell the user",
  outside_workspace: "the target is outside the workspace; stay inside the project",
  excluded_path: "this path is excluded (sensitive file); do not access it",
  contract_forbids: "the mission contract does not allow this; tell the user what you would need",
  domain_policy: "the project's domain policy does not allow this site; use another source or tell the user",
};

/** Owner rule as a decision; a failing owner check (invalid or blocked URL) refuses. */
async function ownerDecision(
  executor: ToolExecutor,
  args: unknown,
  scope: { workspaceId: string; missionHosts: readonly string[] | null },
): Promise<{ decision: PermissionDecision; detail: string } | null> {
  if (!executor.ownerPolicy) return null;
  let policy: OwnerPolicy | null;
  try {
    policy = await executor.ownerPolicy(args, scope);
  } catch (error) {
    const failure = toToolFailure(error, new AbortController().signal);
    policy = { decision: "deny", reason: "domain_policy", detail: failure.message };
  }
  if (!policy) return null;
  return {
    decision: {
      decision: policy.decision,
      reason: policy.reason,
      ruleId: `owner:${policy.reason}`,
      // S6: an MCP tool set to "ask" asks every time; a host approval may be remembered.
      rememberable: policy.reason === "domain_policy" && policy.decision === "ask",
      explanation: OWNER_EXPLANATIONS[policy.reason][policy.decision],
    },
    detail: policy.detail,
  };
}

/** `allowedHosts: []` means "no host restriction beyond the project's policy" (W4 restricts only). */
export function missionHostsOf(contract: MissionContract): readonly string[] | null {
  return contract.allowedHosts.length > 0 ? contract.allowedHosts : null;
}

export function createToolGateway(deps: ToolGatewayDeps): ToolGateway {
  const now = deps.now ?? Date.now;

  return {
    async run(request: ToolRunRequest, callSignal: AbortSignal): Promise<ToolResult> {
      const context = deps.context(request.missionId);
      if (!context || context.signal.aborted) return errorResult(request.id, "unavailable", "this mission is not running");
      const signal = AbortSignal.any([callSignal, context.signal]);
      if (!isToolName(request.name)) {
        return errorResult(request.id, "invalid_arguments", `unknown tool "${request.name.slice(0, 64)}"; use one of the tools provided`);
      }
      const name = request.name;
      const executor = context.registry.get(name);
      const operation = executor?.operation ?? "external";
      const parsed = executor ? context.registry.parseArguments(name, request.rawArguments) : null;
      let facts: ToolPermissionFacts[] = [{}];
      let factsError: { code: Parameters<typeof errorResult>[1]; message: string } | null = null;
      if (executor && parsed?.ok) {
        try {
          facts = await executor.permissionFacts(parsed.args);
        } catch (error) {
          factsError = toToolFailure(error, signal);
        }
      }
      const first = facts[0] ?? {};
      const summary: ToolCallSummary = {
        id: request.id,
        name,
        operation,
        argumentsPreview: preview(request.rawArguments),
        path: first.path ?? null,
        host: first.host ?? null,
        argv: first.argv?.map(redactSecrets) ?? null,
      };
      const started = now();
      const missionHosts = missionHostsOf(context.contract);
      deps.toolCalls.insert({ id: request.id, missionId: context.missionId, tool: name, operation, arguments: summary.argumentsPreview });
      deps.journal.append({ type: "tool.requested", missionId: context.missionId, call: summary, taskId: null });

      let finished = false;
      const finish = (state: "succeeded" | "failed" | "cancelled" | "denied", raw: ToolResult): ToolResult => {
        if (finished) return raw;
        finished = true;
        const result = { ...raw, display: redactDisplay(raw.display) };
        deps.toolCalls.finish(request.id, state, { exitCode: exitCodeOf(result.display), resultSummary: summaryOf(result) });
        deps.journal.append({
          type: "tool.finished",
          missionId: context.missionId,
          callId: request.id,
          state,
          display: result.display,
          durationMs: now() - started,
        });
        deps.audit?.({
          workspaceId: context.workspaceId,
          missionId: context.missionId,
          toolCallId: request.id,
          tool: name,
          operation,
          target: summary.path ?? summary.host ?? null,
          argv: (result as ExecutedToolResult).argv ?? summary.argv,
          state,
          exitCode: exitCodeOf(result.display),
          durationMs: now() - started,
        });
        return result;
      };

      try {
        // Unknown in this mission (e.g. a disabled MCP tool) or malformed arguments: never executed.
        if (!executor || !parsed) {
          return finish("failed", errorResult(request.id, "unavailable", `the tool "${name}" is not available in this mission`));
        }
        if (!parsed.ok) return finish("failed", errorResult(request.id, "invalid_arguments", parsed.error));
        if (factsError) return finish("failed", errorResult(request.id, factsError.code, factsError.message));

        const permissionRequest = (fact: ToolPermissionFacts): PermissionRequest => ({
          workspaceId: context.workspaceId,
          missionId: context.missionId,
          tool: name,
          operation,
          ...fact,
          mode: context.mode,
          tainted: context.tainted,
        });
        let ownerDetail: string | null = null;
        /** The fact whose decision is the strictest: the approval is about that target. */
        let decidingFact: ToolPermissionFacts = first;
        const decide = async (): Promise<PermissionDecision> => {
          if (!context.allowedTools.has(name)) {
            const refusal: PermissionDecision = {
              decision: "deny",
              reason: "mode_forbids",
              ruleId: `builtin:mode-${context.mode}`,
              rememberable: false,
              explanation: "Ce mode de travail n'autorise pas cet outil.",
            };
            deps.auditDecision?.(permissionRequest(first), refusal, request.id);
            return refusal;
          }
          const decisions: PermissionDecision[] = [];
          for (const fact of facts) decisions.push(await deps.permissions.evaluate(permissionRequest(fact), { toolCallId: request.id }));
          const owner = await ownerDecision(executor, parsed.args, { workspaceId: context.workspaceId, missionHosts });
          // The domain policy's question was already answered: the user approved this host "for this
          // mission / project", which the engine applies as a remembered rule for that host. Asking
          // again on every call would ignore the answer the card promised to remember.
          const hostRemembered = decisions.every((decision) => decision.decision === "allow" && decision.reason === "remembered_approval");
          const answered = owner?.decision.decision === "ask" && owner.decision.reason === "domain_policy" && hostRemembered;
          if (owner && !answered) {
            ownerDetail = owner.detail;
            decisions.push(owner.decision);
          }
          const strictest = strictestDecision(decisions);
          // strictestDecision keeps the first decision of the highest rank; an owner's comes after the facts.
          const decidingIndex = decisions.findIndex((decision) => decision.decision === strictest.decision);
          decidingFact = facts[decidingIndex] ?? first;
          if (decidingIndex >= facts.length) deps.auditDecision?.(permissionRequest(decidingFact), strictest, request.id);
          return strictest;
        };
        const decision = await decide();
        const approvalRequest = (): PermissionRequest => {
          const paths = facts.flatMap((fact) => (fact.path === undefined ? [] : [fact.path]));
          return { ...permissionRequest(decidingFact), ...(paths.length > 1 ? { paths } : {}) };
        };
        deps.toolCalls.setDecision(request.id, decision.decision, decision.ruleId);

        if (decision.decision === "ask") {
          let pendingEmitted = false;
          const approval = await deps.approvals.request(
            { request: approvalRequest(), decision, toolCallId: request.id, missionId: context.missionId },
            {
              signal,
              onPending: (pending) => {
                pendingEmitted = true;
                deps.journal.append({ type: "tool.permission", missionId: context.missionId, callId: request.id, decision, approvalId: pending.id });
                deps.journal.append({ type: "approval.requested", missionId: context.missionId, approval: pending });
              },
            },
          );
          if (!pendingEmitted) {
            deps.journal.append({ type: "tool.permission", missionId: context.missionId, callId: request.id, decision, approvalId: approval.id });
          }
          deps.journal.append({ type: "approval.resolved", missionId: context.missionId, approval });
          if (signal.aborted) return finish("cancelled", errorResult(request.id, "cancelled", "stopped by the user"));
          if (approval.status !== "approved") {
            return finish(
              "denied",
              errorResult(request.id, "permission_denied", "the user refused this action; do not retry it, adapt your plan or ask the user"),
            );
          }
          deps.toolCalls.setDecision(request.id, "allow", decision.ruleId);
        } else {
          deps.journal.append({ type: "tool.permission", missionId: context.missionId, callId: request.id, decision, approvalId: null });
          if (decision.decision === "deny") {
            const hint = ownerDetail ?? REFUSAL_HINT[decision.reason] ?? "refused by the permission policy; do not retry the same action";
            return finish("denied", errorResult(request.id, "permission_denied", `refused (${decision.reason}): ${hint}`));
          }
        }
        if (signal.aborted) return finish("cancelled", errorResult(request.id, "cancelled", "stopped by the user"));

        // A10: a restore point before any write or delete; the file API snapshots into it.
        let checkpointId: string | null = null;
        const paths = executor.checkpointPaths(parsed.args);
        if ((operation === "write" || operation === "delete") && paths.length > 0) {
          if (!deps.checkpoints) return finish("failed", errorResult(request.id, "unavailable", "restore points are unavailable; writing is disabled"));
          const checkpoint = deps.checkpoints.create({
            workspaceId: context.workspaceId,
            missionId: context.missionId,
            label: `${name} ${paths.join(", ")}`.slice(0, 200),
            reason: "tool_write",
          });
          checkpointId = checkpoint.id;
          deps.journal.append({ type: "checkpoint.created", missionId: context.missionId, checkpoint });
        }

        deps.toolCalls.markRunning(request.id);
        deps.journal.append({
          type: "tool.started",
          missionId: context.missionId,
          callId: request.id,
          isolationLevel: operation === "execute" ? context.contract.isolationLevel : null,
        });
        let result: ExecutedToolResult = await executor.execute(parsed.args, {
          workspaceId: context.workspaceId,
          missionId: context.missionId,
          callId: request.id,
          signal,
          checkpointId,
          seenVersions: context.seenVersions,
          missionHosts,
          // Live output of this call only: a background process keeps printing after its call ended.
          onOutput: (stream, chunk) => {
            if (finished) return;
            deps.journal.append({ type: "tool.output", missionId: context.missionId, callId: request.id, stream, chunk: redactSecrets(chunk.slice(0, 16_000)) });
          },
        });
        if (result.provenance.untrusted) context.tainted = true;
        // Redacted once here: the proof, the journal and the evidence all see the same argv.
        result = { ...result, display: redactDisplay(result.display), ...(result.argv ? { argv: result.argv.map(redactSecrets) } : {}) };
        result = recordProof(deps, context.missionId, request.id, result);
        const { argv: _argv, ...forModel } = result;
        finish(finishedState(result), result);
        return forModel;
      } catch {
        return finish(
          signal.aborted ? "cancelled" : "failed",
          errorResult(request.id, signal.aborted ? "cancelled" : "failed", signal.aborted ? "stopped by the user" : "the tool failed unexpectedly"),
        );
      }
    },
  };
}

/** A4: tests and foreground commands leave a proof; the tests card points to it. */
function recordProof(deps: ToolGatewayDeps, missionId: string, callId: string, result: ExecutedToolResult): ExecutedToolResult {
  const display = result.display;
  if (display.kind === "tests") {
    const proof = deps.proofs.insert({
      missionId,
      taskId: null,
      toolCallId: callId,
      kind: "test",
      command: result.argv ?? null,
      exitCode: display.exitCode,
      summary: summaryOf(result),
      outputRef: null,
    });
    deps.journal.append({ type: "proof.recorded", missionId, proof });
    return { ...result, display: { ...display, proofId: proof.id } };
  }
  if (display.kind === "command" && display.exitCode !== null) {
    const proof = deps.proofs.insert({
      missionId,
      taskId: null,
      toolCallId: callId,
      kind: "command",
      command: display.argv,
      exitCode: display.exitCode,
      summary: `\`${display.argv.join(" ")}\` → code ${String(display.exitCode)}`,
      outputRef: display.outputArtifactId,
    });
    deps.journal.append({ type: "proof.recorded", missionId, proof });
  }
  return result;
}
