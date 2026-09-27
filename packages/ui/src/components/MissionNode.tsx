import type { KeyboardEvent, ReactNode, Ref } from "react";
import { Ban, Check, CirclePause, X } from "lucide-react";
import { cx } from "../cx";
import { OrbitIndicator } from "./OrbitIndicator";

export type MissionNodeStatus = "ready" | "running" | "waiting" | "suspended" | "succeeded" | "failed" | "cancelled" | "skipped";

export interface MissionNodeProps {
  index: number;
  title: string;
  facts?: ReactNode;
  status: MissionNodeStatus;
  statusLabel: string;
  /** « Étape 3, Modifier, en cours ». */
  accessibleName: string;
  selected: boolean;
  onSelect: () => void;
  /** Default true: the orbit turns on the running node (false when another region already spins). */
  orbit?: boolean;
  id?: string;
  onKeyDown?: (event: KeyboardEvent<HTMLButtonElement>) => void;
  tabIndex?: number;
  className?: string;
  ref?: Ref<HTMLButtonElement>;
}

function StatusMark({ status, orbit }: { status: MissionNodeStatus; orbit: boolean }) {
  switch (status) {
    case "running":
      return orbit ? <OrbitIndicator active size={14} /> : <span className="nv-mnode__dot" aria-hidden />;
    case "waiting":
    case "suspended":
      return <CirclePause size={14} aria-hidden />;
    case "succeeded":
      return <Check size={14} aria-hidden />;
    case "failed":
      return <X size={14} aria-hidden />;
    case "cancelled":
    case "skipped":
      return <Ban size={14} aria-hidden />;
    case "ready":
      return <span className="nv-mnode__dot nv-mnode__dot--idle" aria-hidden />;
  }
}

/** A step of the mission map (VISUAL.md §5.9). */
export function MissionNode({
  index,
  title,
  facts,
  status,
  statusLabel,
  accessibleName,
  selected,
  onSelect,
  orbit = true,
  id,
  onKeyDown,
  tabIndex,
  className,
  ref,
}: MissionNodeProps) {
  return (
    <button
      ref={ref}
      id={id}
      type="button"
      className={cx("nv-mnode", `nv-mnode--${status}`, selected && "nv-mnode--selected", className)}
      aria-pressed={selected}
      aria-label={accessibleName}
      tabIndex={tabIndex}
      onClick={onSelect}
      onKeyDown={onKeyDown}
    >
      <span className="nv-mnode__head">
        <span className="nv-mnode__index">{index}</span>
        <span className="nv-mnode__title">{title}</span>
        <span className="nv-mnode__status" title={statusLabel}>
          <StatusMark status={status} orbit={orbit} />
        </span>
      </span>
      {facts ? <span className="nv-mnode__facts">{facts}</span> : null}
    </button>
  );
}
