import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from "react";
import { CircleCheck, CircleX, ShieldAlert } from "lucide-react";
import { cx } from "../cx";
import { Button } from "./Button";

export interface ApprovalFact {
  label: string;
  value: ReactNode;
  tone?: "danger";
}

export interface ApprovalCardProps {
  title: ReactNode;
  facts: readonly ApprovalFact[];
  /** Why the agent asks (its stated reason). */
  reason?: ReactNode;
  /** Warning text, e.g. irreversible effect or untrusted content read before. */
  notice?: ReactNode;
  /** Danger border; the "for this mission" answer is never offered. */
  irreversible: boolean;
  rememberable: boolean;
  status: "pending" | "approved" | "denied" | "expired";
  /** Collapsed line shown once decided (immutable). */
  decidedLabel?: ReactNode;
  labels: { approveOnce: string; approveMission: string; deny: string; shortcuts?: string };
  busy?: boolean;
  onApproveOnce: () => void;
  onApproveMission: () => void;
  onDeny: () => void;
  /** Each new non-null value moves focus to "approve once" (the caller never asks while the user types). */
  focusRequest?: number | null;
  className?: string;
  id?: string;
}

/**
 * A permission request (VISUAL.md §5.7). Keyboard, from anywhere inside the card: Ctrl/⌘+Enter
 * approves once, Ctrl/⌘+Shift+Enter approves for the mission, Escape denies. Never a single key.
 */
export function ApprovalCard({
  title,
  facts,
  reason,
  notice,
  irreversible,
  rememberable,
  status,
  decidedLabel,
  labels,
  busy = false,
  onApproveOnce,
  onApproveMission,
  onDeny,
  focusRequest = null,
  className,
  id,
}: ApprovalCardProps) {
  const titleId = useId();
  const factsId = useId();
  const primary = useRef<HTMLButtonElement>(null);
  const pending = status === "pending";
  const missionAllowed = rememberable && !irreversible;

  // Only a new request value moves focus; a status change alone never steals it.
  const handled = useRef<number | null>(null);
  useEffect(() => {
    if (focusRequest === null || focusRequest === handled.current) return;
    handled.current = focusRequest;
    if (pending) primary.current?.focus();
  }, [focusRequest, pending]);

  if (!pending) {
    const Icon = status === "approved" ? CircleCheck : CircleX;
    return (
      <div id={id} className={cx("nv-approval", "nv-approval--decided", `nv-approval--${status}`, className)}>
        <Icon size={16} aria-hidden className="nv-approval__icon" />
        <span className="nv-approval__title">{title}</span>
        {decidedLabel ? <span className="nv-approval__decided">{decidedLabel}</span> : null}
      </div>
    );
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (busy || event.nativeEvent.isComposing) return;
    const mod = event.ctrlKey || event.metaKey;
    let action: (() => void) | null = null;
    if (event.key === "Enter" && mod && !event.altKey) {
      if (event.shiftKey) action = missionAllowed ? onApproveMission : null;
      else action = onApproveOnce;
    } else if (event.key === "Escape" && !mod && !event.shiftKey && !event.altKey) {
      action = onDeny;
    }
    if (!action) return;
    event.preventDefault();
    event.stopPropagation();
    action();
  };

  return (
    // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- keyboard shortcuts of a non-modal dialog
    <div
      id={id}
      className={cx("nv-approval", irreversible && "nv-approval--irreversible", className)}
      role="alertdialog"
      aria-modal="false"
      aria-labelledby={titleId}
      aria-describedby={factsId}
      onKeyDown={onKeyDown}
    >
      <div className="nv-approval__head">
        <ShieldAlert size={16} aria-hidden className="nv-approval__icon" />
        <h3 id={titleId} className="nv-approval__title">
          {title}
        </h3>
      </div>
      <dl id={factsId} className="nv-approval__facts">
        {facts.map((fact) => (
          <div key={fact.label} className={cx("nv-approval__fact", fact.tone === "danger" && "nv-approval__fact--danger")}>
            <dt>{fact.label}</dt>
            <dd>{fact.value}</dd>
          </div>
        ))}
      </dl>
      {notice ? <p className="nv-approval__notice">{notice}</p> : null}
      {reason ? <p className="nv-approval__reason">{reason}</p> : null}
      <div className="nv-approval__actions">
        <Button ref={primary} variant="primary" size="sm" disabled={busy} onClick={onApproveOnce}>
          {labels.approveOnce}
        </Button>
        {missionAllowed ? (
          <Button variant="secondary" size="sm" disabled={busy} onClick={onApproveMission}>
            {labels.approveMission}
          </Button>
        ) : null}
        <Button variant="ghost" size="sm" className="nv-approval__deny" disabled={busy} onClick={onDeny}>
          {labels.deny}
        </Button>
      </div>
      {labels.shortcuts ? <p className="nv-approval__shortcuts">{labels.shortcuts}</p> : null}
    </div>
  );
}
