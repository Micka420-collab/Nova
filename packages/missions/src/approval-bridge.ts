// Adapts the approvals service of main (L1 `ApprovalsService`: `request()` resolves "approved" |
// "denied" and reports the approval rows through its `emit`) to the gateway's `ApprovalGate`.
// Main passes `bridge.onEvent` as the service's `emit`: events of a call the gateway is waiting on
// go to that call (the gateway journals them in order, next to `tool.permission`); any other
// approval event of a mission is journaled directly. Nothing is journaled twice.
import type { Approval, PermissionDecision, PermissionRequest } from "@nova/shared";
import type { ApprovalGate } from "./gateway";
import type { MissionEventInput } from "./index";

export interface ApprovalServiceLike {
  request(input: { request: PermissionRequest; decision: PermissionDecision; toolCallId: string | null }): Promise<"approved" | "denied">;
  /** Expires the mission's pending approvals; their waiting calls resolve "denied". */
  cancelMission(missionId: string): unknown;
}

export type ApprovalEventLike = { type: "approval.requested" | "approval.resolved"; approval: Approval };

export interface ApprovalBridge {
  gate: ApprovalGate;
  /** Wire as the approvals service's `emit`. */
  onEvent(event: ApprovalEventLike): void;
}

interface Waiter {
  onPending(approval: Approval): void;
  resolved: Approval | null;
}

export function createApprovalBridge(deps: {
  approvals: ApprovalServiceLike;
  journal: { append(event: MissionEventInput): unknown };
  now?: () => number;
}): ApprovalBridge {
  const now = deps.now ?? Date.now;
  const waiters = new Map<string, Waiter>();

  return {
    onEvent(event) {
      const waiter = event.approval.toolCallId ? waiters.get(event.approval.toolCallId) : undefined;
      if (waiter) {
        if (event.type === "approval.requested") waiter.onPending(event.approval);
        else waiter.resolved = event.approval;
        return;
      }
      const missionId = event.approval.request.missionId;
      if (missionId) deps.journal.append({ type: event.type, missionId, approval: event.approval });
    },

    gate: {
      async request(input, options) {
        const waiter: Waiter = { onPending: options.onPending, resolved: null };
        waiters.set(input.toolCallId, waiter);
        // A stopped mission expires its pending approvals: the waiting call resolves "denied".
        const onAbort = (): void => void deps.approvals.cancelMission(input.missionId);
        options.signal.addEventListener("abort", onAbort, { once: true });
        try {
          const pending = deps.approvals.request({ request: input.request, decision: input.decision, toolCallId: input.toolCallId });
          // Stopped while the approval was being created: expire it right away.
          if (options.signal.aborted) onAbort();
          const outcome = await pending;
          return (
            waiter.resolved ?? {
              id: `unrecorded-${input.toolCallId}`,
              request: input.request,
              decision: input.decision,
              toolCallId: input.toolCallId,
              status: outcome === "approved" ? "approved" : options.signal.aborted ? "expired" : "denied",
              scope: outcome === "approved" ? "once" : null,
              createdAt: now(),
              decidedAt: now(),
            }
          );
        } finally {
          options.signal.removeEventListener("abort", onAbort);
          waiters.delete(input.toolCallId);
        }
      },
    },
  };
}
