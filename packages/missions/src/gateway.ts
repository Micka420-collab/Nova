// Tool gateway (main side, S1/A12/A10): the only path from a model tool call to an effect.
// Order per call: journal `tool.requested` → parse + validate arguments (invalid → error result,
// never executed) → mode check (`mode_forbids`) → `permissions.evaluate` for every target
// (strictest wins) → `ask` waits for the approval → checkpoint before writes → execute → journal
// `tool.finished` (exactly once, whatever happens) → proof for tests/commands.
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
import { errorResult, type ToolPermissionFacts, type ToolRegistry } from "@nova/tools";
import type { MissionEventInput, ToolGateway, ToolRunRequest } from "./index";

export interface PermissionGate {
  evaluate(request: PermissionRequest): PermissionDecision | Promise<PermissionDecision>;
}

export interface ApprovalGate {
  /**
   * Creates the pending approval (L1 `approvals.request`), reports it through `onPending`, and
   * resolves with the decided approval. An aborted signal must resolve it as `expired`.
   */
  request(
    input: { request: PermissionRequest; decision: PermissionDecision; toolCallId: string; missionId: string },
    options: { signal: AbortSignal; onPending(approval: Approval): void },
  ): Promise<Approval>;
}

export interface CheckpointGate {
  capture(input: { workspaceId: string; missionId: string; label: string; reason: "tool_write"; paths: RelativePath[] }): Promise<Checkpoint>;
  /** Records the after-hashes of a checkpoint once the tool has written (A10). */
  complete?(checkpointId: string): Promise<void>;
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
  /** Audit trail (S5): one entry per decision and per outcome. */
  audit?: (entry: {
    workspaceId: string;
    missionId: string;
    toolCallId: string;
    action: string;
    decision: PermissionDecision["decision"] | null;
    ruleId: string | null;
    target: string | null;
    outcome: string;
  }) => void;
  now?: () => number;
}

const RANK: Record<PermissionDecision["decision"], number> = { allow: 0, ask: 1, deny: 2 };

/** deny > ask > allow; among equals the first one (its rule is the one shown). */
export function strictestDecision(decisions: readonly PermissionDecision[]): PermissionDecision {
  let result: PermissionDecision | null = null;
  for (const decision of decisions) if (!result || RANK[decision.decision] > RANK[result.decision]) result = decision;
  return result ?? { decision: "ask", reason: "default_ask", ruleId: null, rememberable: true };
}

function preview(raw: string): string {
  const text = redactSecrets(raw);
  return text.length > 2_000 ? `${text.slice(0, 2_000)}…` : text;
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
    case "tests":
      return `${String(display.passed ?? "?")} réussis, ${String(display.failed ?? "?")} échecs, code ${String(display.exitCode)}`;
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
};

export function createToolGateway(deps: ToolGatewayDeps): ToolGateway {
  const now = deps.now ?? Date.now;

  return {
    async run(request: ToolRunRequest, signal: AbortSignal): Promise<ToolResult> {
      const context = deps.context(request.missionId);
      if (!context) return errorResult(request.id, "unavailable", "this mission is not running");
      if (!isToolName(request.name)) {
        return errorResult(request.id, "invalid_arguments", `unknown tool "${request.name.slice(0, 64)}"; use one of the tools provided`);
      }
      const name = request.name;
      const executor = context.registry.get(name);
      const operation = executor?.operation ?? "external";
      const parsed = executor ? context.registry.parseArguments(name, request.rawArguments) : null;
      const facts: ToolPermissionFacts[] = executor && parsed?.ok ? executor.permissionFacts(parsed.args) : [{}];
      const first = facts[0] ?? {};
      const summary: ToolCallSummary = {
        id: request.id,
        name,
        operation,
        argumentsPreview: preview(request.rawArguments),
        path: first.path ?? null,
        host: first.host ?? null,
        argv: first.argv ?? null,
      };
      const started = now();
      deps.toolCalls.insert({ id: request.id, missionId: context.missionId, tool: name, operation, arguments: summary.argumentsPreview });
      deps.journal.append({ type: "tool.requested", missionId: context.missionId, call: summary, taskId: null });

      let finished = false;
      const finish = (state: "succeeded" | "failed" | "cancelled" | "denied", result: ToolResult): ToolResult => {
        if (finished) return result;
        finished = true;
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
          action: `tool.${name}`,
          decision: null,
          ruleId: null,
          target: summary.path ?? summary.host ?? summary.argv?.[0] ?? null,
          outcome: state,
        });
        return result;
      };

      try {
        // Unknown in this mission (e.g. a disabled MCP tool) or malformed arguments: never executed.
        if (!executor || !parsed) {
          return finish("failed", errorResult(request.id, "unavailable", `the tool "${name}" is not available in this mission`));
        }
        if (!parsed.ok) return finish("failed", errorResult(request.id, "invalid_arguments", parsed.error));

        const decide = async (): Promise<PermissionDecision> => {
          if (!context.allowedTools.has(name)) {
            return { decision: "deny", reason: "mode_forbids", ruleId: `builtin:mode-${context.mode}`, rememberable: false };
          }
          const decisions: PermissionDecision[] = [];
          for (const fact of facts) {
            decisions.push(
              await deps.permissions.evaluate({
                workspaceId: context.workspaceId,
                missionId: context.missionId,
                tool: name,
                operation,
                ...fact,
                mode: context.mode,
                tainted: context.tainted,
              }),
            );
          }
          return strictestDecision(decisions);
        };
        const decision = await decide();
        deps.toolCalls.setDecision(request.id, decision.decision, decision.ruleId);
        deps.audit?.({
          workspaceId: context.workspaceId,
          missionId: context.missionId,
          toolCallId: request.id,
          action: `permission.${name}`,
          decision: decision.decision,
          ruleId: decision.ruleId,
          target: summary.path ?? summary.host ?? summary.argv?.[0] ?? null,
          outcome: decision.reason,
        });

        let approvalId: string | null = null;
        if (decision.decision === "ask") {
          let pendingEmitted = false;
          const approval = await deps.approvals.request(
            {
              request: { workspaceId: context.workspaceId, missionId: context.missionId, tool: name, operation, ...first, mode: context.mode, tainted: context.tainted },
              decision,
              toolCallId: request.id,
              missionId: context.missionId,
            },
            {
              signal,
              onPending: (pending) => {
                pendingEmitted = true;
                approvalId = pending.id;
                deps.journal.append({ type: "tool.permission", missionId: context.missionId, callId: request.id, decision, approvalId: pending.id });
                deps.journal.append({ type: "approval.requested", missionId: context.missionId, approval: pending });
              },
            },
          );
          approvalId = approval.id;
          if (!pendingEmitted) {
            deps.journal.append({ type: "tool.permission", missionId: context.missionId, callId: request.id, decision, approvalId });
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
            const hint = REFUSAL_HINT[decision.reason] ?? "refused by the permission policy; do not retry the same action";
            return finish("denied", errorResult(request.id, "permission_denied", `refused (${decision.reason}): ${hint}`));
          }
        }
        if (signal.aborted) return finish("cancelled", errorResult(request.id, "cancelled", "stopped by the user"));

        // A10: snapshot before any write or delete.
        let checkpointId: string | null = null;
        const paths = executor.checkpointPaths(parsed.args);
        if ((operation === "write" || operation === "delete") && paths.length > 0) {
          if (!deps.checkpoints) return finish("failed", errorResult(request.id, "unavailable", "restore points are unavailable; writing is disabled"));
          const checkpoint = await deps.checkpoints.capture({
            workspaceId: context.workspaceId,
            missionId: context.missionId,
            label: `${name} ${paths.join(", ")}`.slice(0, 200),
            reason: "tool_write",
            paths,
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
        let result = await executor.execute(parsed.args, {
          workspaceId: context.workspaceId,
          missionId: context.missionId,
          callId: request.id,
          signal,
          checkpointId,
          seenVersions: context.seenVersions,
          onOutput: (stream, chunk) =>
            deps.journal.append({ type: "tool.output", missionId: context.missionId, callId: request.id, stream, chunk: chunk.slice(0, 16_000) }),
        });
        if (checkpointId && deps.checkpoints?.complete) await deps.checkpoints.complete(checkpointId);
        if (result.provenance.untrusted) context.tainted = true;
        result = recordProof(deps, context.missionId, request.id, result);
        return finish(finishedState(result), result);
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
function recordProof(deps: ToolGatewayDeps, missionId: string, callId: string, result: ToolResult): ToolResult {
  const display = result.display;
  const argv = /^\$ (.+)$/m.exec(result.content)?.[1]?.split(" ") ?? null;
  if (display.kind === "tests") {
    const proof = deps.proofs.insert({
      missionId,
      taskId: null,
      toolCallId: callId,
      kind: "test",
      command: argv,
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

