import type { MouseEvent } from "react";
import { Brain, FileText, Globe, Plug, SquareTerminal, type LucideIcon } from "lucide-react";
import { cx } from "../cx";

export type CitationKind = "file" | "terminal" | "web" | "mcp" | "memory";

const ICONS: Record<CitationKind, LucideIcon> = {
  file: FileText,
  terminal: SquareTerminal,
  web: Globe,
  mcp: Plug,
  memory: Brain,
};

export interface CitationChipProps {
  kind: CitationKind;
  label: string;
  accessibleName: string;
  /** Full path or URL shown on hover. */
  title?: string;
  /** The source no longer exists (line moved, file deleted). */
  stale?: boolean;
  staleLabel?: string;
  /** `background`: Ctrl/⌘+click opens without taking the view. */
  onOpen: (options: { background: boolean }) => void;
  className?: string;
}

/** Inline source reference (VISUAL.md §5.5): always a button, never a bare span. */
export function CitationChip({ kind, label, accessibleName, title, stale = false, staleLabel, onOpen, className }: CitationChipProps) {
  const Icon = ICONS[kind];
  const tooltip = stale && staleLabel ? (title ? `${title} — ${staleLabel}` : staleLabel) : title;
  return (
    <button
      type="button"
      className={cx("nv-citation", stale && "nv-citation--stale", className)}
      aria-label={stale && staleLabel ? `${accessibleName} (${staleLabel})` : accessibleName}
      title={tooltip}
      onClick={(event: MouseEvent<HTMLButtonElement>) => onOpen({ background: event.ctrlKey || event.metaKey })}
    >
      <Icon size={12} aria-hidden />
      <span className="nv-citation__label">{label}</span>
    </button>
  );
}
