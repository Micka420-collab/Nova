import { useId, type ReactNode } from "react";
import { Ban, Check, ChevronRight, CirclePause, Eye, GitBranch, Globe, Pencil, Plug, Search, SquareTerminal, X, type LucideIcon } from "lucide-react";
import { cx } from "../cx";
import { OrbitIndicator } from "./OrbitIndicator";

export type ToolCallKind = "read" | "search" | "edit" | "terminal" | "git" | "web" | "mcp";
export type ToolCallStatus = "requested" | "waiting" | "running" | "succeeded" | "failed" | "cancelled" | "denied";

const KIND_ICONS: Record<ToolCallKind, LucideIcon> = {
  read: Eye,
  search: Search,
  edit: Pencil,
  terminal: SquareTerminal,
  git: GitBranch,
  web: Globe,
  mcp: Plug,
};

function StatusIcon({ status, orbit }: { status: ToolCallStatus; orbit: boolean }) {
  switch (status) {
    case "running":
      return orbit ? <OrbitIndicator active size={14} /> : <span className="nv-toolcard__dot" aria-hidden />;
    case "succeeded":
      return <Check size={14} aria-hidden className="nv-toolcard__ok" />;
    case "failed":
      return <X size={14} aria-hidden className="nv-toolcard__ko" />;
    case "waiting":
      return <CirclePause size={14} aria-hidden className="nv-toolcard__wait" />;
    case "denied":
      return <Ban size={14} aria-hidden className="nv-toolcard__ko" />;
    case "cancelled":
      return <Ban size={14} aria-hidden className="nv-toolcard__muted" />;
    case "requested":
      return <span className="nv-toolcard__dot nv-toolcard__dot--idle" aria-hidden />;
  }
}

interface HeaderProps {
  kind: ToolCallKind;
  title: ReactNode;
  status: ToolCallStatus;
  statusLabel: string;
  duration?: string | null;
  orbit: boolean;
  expanded: boolean;
  bodyId: string;
  onToggle: () => void;
}

function CardHeader({ kind, title, status, statusLabel, duration, orbit, expanded, bodyId, onToggle }: HeaderProps) {
  const Icon = KIND_ICONS[kind];
  return (
    <button
      type="button"
      className="nv-toolcard__header"
      aria-expanded={expanded}
      aria-controls={bodyId}
      onClick={onToggle}
    >
      <ChevronRight size={16} aria-hidden className="nv-toolcard__chevron" />
      <Icon size={16} aria-hidden className="nv-toolcard__kind" />
      <span className="nv-toolcard__title">{title}</span>
      <span className="nv-toolcard__status">
        <StatusIcon status={status} orbit={orbit} />
        <span className="nv-visually-hidden">{statusLabel}</span>
      </span>
      {duration ? <span className="nv-toolcard__duration">{duration}</span> : null}
    </button>
  );
}

export interface ToolCallCardProps {
  kind: ToolCallKind;
  /** Verb + target; the caller wraps code in <code>. */
  title: ReactNode;
  status: ToolCallStatus;
  /** French status, part of the toggle's accessible name and announced politely on change. */
  statusLabel: string;
  duration?: string | null;
  /** Default true: the orbit turns while running. False when a parent region already shows it (single focus). */
  orbit?: boolean;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  children?: ReactNode;
  actions?: ReactNode;
  className?: string;
}

/** One tool call of the agent's journal (VISUAL.md §5.4): one line folded, details unfolded. */
export function ToolCallCard({
  kind,
  title,
  status,
  statusLabel,
  duration,
  orbit = true,
  expanded,
  onExpandedChange,
  children,
  actions,
  className,
}: ToolCallCardProps) {
  const bodyId = useId();
  return (
    <div className={cx("nv-toolcard", `nv-toolcard--${status}`, expanded && "nv-toolcard--expanded", className)}>
      <CardHeader
        kind={kind}
        title={title}
        status={status}
        statusLabel={statusLabel}
        duration={duration}
        orbit={orbit}
        expanded={expanded}
        bodyId={bodyId}
        onToggle={() => onExpandedChange(!expanded)}
      />
      <span className="nv-visually-hidden" aria-live="polite">
        {statusLabel}
      </span>
      <div id={bodyId} className="nv-toolcard__body" hidden={!expanded}>
        {expanded ? (
          <>
            <div className="nv-toolcard__content">{children}</div>
            {actions ? <div className="nv-toolcard__actions">{actions}</div> : null}
          </>
        ) : null}
      </div>
    </div>
  );
}

export interface ToolCallGroupProps {
  kind: ToolCallKind;
  label: ReactNode;
  status: ToolCallStatus;
  statusLabel: string;
  orbit?: boolean;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  children?: ReactNode;
  className?: string;
}

/** A folded run of consecutive calls of one kind ("7 lectures · 0,9 s"); the orbit sits on the group. */
export function ToolCallGroup({
  kind,
  label,
  status,
  statusLabel,
  orbit = true,
  expanded,
  onExpandedChange,
  children,
  className,
}: ToolCallGroupProps) {
  const bodyId = useId();
  return (
    <div className={cx("nv-toolcard", "nv-toolcard--group", `nv-toolcard--${status}`, expanded && "nv-toolcard--expanded", className)}>
      <CardHeader
        kind={kind}
        title={label}
        status={status}
        statusLabel={statusLabel}
        orbit={orbit}
        expanded={expanded}
        bodyId={bodyId}
        onToggle={() => onExpandedChange(!expanded)}
      />
      <span className="nv-visually-hidden" aria-live="polite">
        {statusLabel}
      </span>
      <div id={bodyId} className="nv-toolcard__group-body" hidden={!expanded}>
        {expanded ? children : null}
      </div>
    </div>
  );
}
