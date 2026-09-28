// Approval card of the timeline (VISUAL.md §5.7, UX.md §5.12, §7.2): what Nomi wants to do, why the
// engine asked, and the three answers. Focus moves here on appearance only when the user is in the
// agent panel and not typing; an explicit navigation (Ctrl+Maj+A, Nomi) always moves it.
import { useEffect, useRef, useState } from "react";
import { ApprovalCard, useToast, type ApprovalFact } from "@nova/ui";
import { isMcpToolName, type Approval, type ApprovalScope } from "@nova/shared";
import { fr } from "../../copy/fr";
import { APPROVAL_SCOPE_LABELS, PERMISSION_REASON_LABELS } from "../../copy/fr-atelier";
import { errorToast } from "../../lib/errors";
import { useApp } from "../../state/context";
import { isEditableElement } from "./typing";

const copy = fr.atelier.approval;
const timeFormat = new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit" });

/** Irreversible effects (S6): external actions, and what the engine asks every time. */
export function isIrreversible(approval: Approval): boolean {
  return approval.request.operation === "external" || approval.decision.reason === "always_ask";
}

export function approvalTargetText(approval: Approval): string | null {
  const { request } = approval;
  if (request.argv && request.argv.length > 0) return request.argv.join(" ");
  return request.path ?? request.host ?? null;
}

function approvalFacts(approval: Approval, workspaceName: string | null): ApprovalFact[] {
  const { request, decision } = approval;
  const facts: ApprovalFact[] = [
    { label: copy.tool, value: <code>{isMcpToolName(request.tool) ? request.tool.replace(/^mcp__/, "").replace("__", " › ") : request.tool}</code> },
  ];
  if (request.argv && request.argv.length > 0) facts.push({ label: copy.command, value: <code>{request.argv.join(" ")}</code> });
  if (request.path) facts.push({ label: copy.path, value: <code>{request.path}</code> });
  if (request.host) facts.push({ label: copy.host, value: <code>{request.host}</code> });
  if (workspaceName) facts.push({ label: copy.scope, value: workspaceName });
  facts.push({
    label: copy.rule,
    value: PERMISSION_REASON_LABELS[decision.reason],
    ...(decision.reason === "dangerous_command" || isIrreversible(approval) ? { tone: "danger" as const } : {}),
  });
  return facts;
}

function decidedLabel(approval: Approval): string {
  const time = approval.decidedAt ? timeFormat.format(approval.decidedAt) : null;
  const label =
    approval.status === "approved"
      ? APPROVAL_SCOPE_LABELS[approval.scope ?? "once"]
      : approval.status === "denied"
        ? copy.denied
        : copy.expired;
  return time ? copy.decidedAt(label, time) : label;
}

/** The user is looking at the agent panel and not typing somewhere: focus may move. */
function mayTakeFocus(card: HTMLElement | null): boolean {
  const active = document.activeElement;
  if (isEditableElement(active)) return false;
  const panel = card?.closest("[data-agent-panel]");
  return active === document.body || active === null || Boolean(panel?.contains(active));
}

export function AgentApproval({ approval }: { approval: Approval }) {
  const decideApproval = useApp((state) => state.decideApproval);
  const workspaceName = useApp((state) => state.workspace.current?.name ?? null);
  const focusRequest = useApp((state) => (state.ui.approvalFocus?.approvalId === approval.id ? state.ui.approvalFocus.nonce : null));
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [autoFocus, setAutoFocus] = useState<number | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const pending = approval.status === "pending";

  // On appearance only: never later, never while the user types elsewhere.
  useEffect(() => {
    if (pending && mayTakeFocus(root.current)) setAutoFocus(Date.now());
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- appearance only
  }, []);

  const decide = (decision: "approve" | "deny", scope: ApprovalScope) => {
    if (busy || !pending) return;
    setBusy(true);
    decideApproval(approval.id, decision, scope)
      .catch((error: unknown) => toast.show(errorToast(error, copy.decideFailed)))
      .finally(() => setBusy(false));
  };

  const irreversible = isIrreversible(approval);
  // Same rule as the card's « Pour cette mission » button: never announce a shortcut it lacks.
  const shortcuts = approval.decision.rememberable && !irreversible ? copy.shortcuts : copy.shortcutsOnce;
  const target = approvalTargetText(approval);
  const notices: string[] = [];
  if (irreversible) notices.push(copy.irreversible);
  if (approval.request.tainted) notices.push(copy.tainted);

  return (
    <div ref={root} className="nova-approval" data-approval-id={approval.id}>
      <ApprovalCard
        id={`approval-${approval.id}`}
        title={
          <>
            {copy.title[approval.request.operation]}
            {target ? (
              <>
                {" "}
                <code>{target}</code>
              </>
            ) : null}
          </>
        }
        facts={approvalFacts(approval, workspaceName)}
        notice={notices.length > 0 ? notices.join(" ") : undefined}
        irreversible={irreversible}
        rememberable={approval.decision.rememberable}
        status={approval.status}
        decidedLabel={pending ? undefined : decidedLabel(approval)}
        labels={{ approveOnce: copy.approveOnce, approveMission: copy.approveMission, deny: copy.deny, shortcuts }}
        busy={busy}
        onApproveOnce={() => decide("approve", "once")}
        onApproveMission={() => decide("approve", "mission")}
        onDeny={() => decide("deny", "once")}
        focusRequest={focusRequest ?? autoFocus}
      />
    </div>
  );
}
