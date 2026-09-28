// Presentational diff (VISUAL.md §5.3): a file with a sticky header and its hunks. Language-neutral:
// every visible or announced text comes from props. Decisions and keyboard live in the caller.
import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cx } from "../cx";

export type DiffLineKind = "context" | "add" | "del";

export interface DiffLine {
  kind: DiffLineKind;
  /** 1-based line number in the old file; null for added lines. */
  oldNumber: number | null;
  /** 1-based line number in the new file; null for deleted lines. */
  newNumber: number | null;
  text: string;
}

export type DiffDecisionState = "pending" | "kept" | "reverted" | "conflict";

/** Lines rendered per hunk before a "show more" button (keeps huge hunks responsive). */
export const DIFF_HUNK_LINE_CAP = 400;

export interface DiffFileProps {
  path: string;
  additions: number;
  deletions: number;
  expanded: boolean;
  onToggle: () => void;
  /** Accessible name of the chevron button (e.g. "Déplier src/form.tsx"). */
  toggleLabel: string;
  /** Proof pill ("test passé 2,1 s", "aucun test"). */
  proof?: ReactNode;
  /** Decision pill ("gardé", "2 sur 3 gardés"). */
  pill?: ReactNode;
  actions?: ReactNode;
  /** Callout under the header (conflict, note). */
  note?: ReactNode;
  current?: boolean;
  children?: ReactNode;
  id?: string;
  className?: string;
}

function splitPath(path: string): { dir: string; name: string } {
  const index = path.lastIndexOf("/");
  return index === -1 ? { dir: "", name: path } : { dir: path.slice(0, index + 1), name: path.slice(index + 1) };
}

export function DiffFile({
  path,
  additions,
  deletions,
  expanded,
  onToggle,
  toggleLabel,
  proof,
  pill,
  actions,
  note,
  current = false,
  children,
  id,
  className,
}: DiffFileProps) {
  const { dir, name } = splitPath(path);
  return (
    <section id={id} className={cx("nv-diff-file", current && "nv-diff-file--current", className)} aria-label={path}>
      <header className="nv-diff-file__header">
        <button type="button" className="nv-diff-file__toggle" aria-expanded={expanded} aria-label={toggleLabel} onClick={onToggle}>
          {expanded ? <ChevronDown size={16} aria-hidden /> : <ChevronRight size={16} aria-hidden />}
        </button>
        <span className="nv-diff-file__path" title={path}>
          {dir ? <span className="nv-diff-file__dir">{dir}</span> : null}
          <span className="nv-diff-file__name">{name}</span>
        </span>
        <span className="nv-diff-file__counts">
          <span className="nv-diff-file__add">+{additions}</span> <span className="nv-diff-file__del">−{deletions}</span>
        </span>
        {proof ? <span className="nv-diff-file__proof">{proof}</span> : null}
        {pill ? <span className="nv-diff-file__pill">{pill}</span> : null}
        {actions ? <span className="nv-diff-file__actions">{actions}</span> : null}
      </header>
      {note ? <div className="nv-diff-file__note">{note}</div> : null}
      {expanded ? <div className="nv-diff-file__body">{children}</div> : null}
    </section>
  );
}

export interface DiffHunkProps {
  /** `@@ -12,7 +12,9 @@` */
  header: string;
  /** Function context after the second `@@`. */
  context?: string;
  lines: DiffLine[];
  decision: DiffDecisionState;
  /** Pill shown when decided ("gardé" / "annulé"). */
  decisionPill?: ReactNode;
  /** Amber callout for a conflict (the hunk is dimmed). */
  conflict?: ReactNode;
  actions?: ReactNode;
  /** Expert: actions always visible (otherwise on hover and focus-within). */
  alwaysShowActions?: boolean;
  /** Accessible name of the region ("hunk 2 sur 3, lignes 12 à 20"). */
  regionLabel: string;
  /** Visually hidden prefixes read before added / deleted lines. */
  lineLabels: { add: string; del: string };
  showMoreLabel: (remaining: number) => string;
  current?: boolean;
  maxLines?: number;
  id?: string;
}

const SIGNS: Record<DiffLineKind, string> = { context: " ", add: "+", del: "−" };

export function DiffHunk({
  header,
  context,
  lines,
  decision,
  decisionPill,
  conflict,
  actions,
  alwaysShowActions = false,
  regionLabel,
  lineLabels,
  showMoreLabel,
  current = false,
  maxLines = DIFF_HUNK_LINE_CAP,
  id,
}: DiffHunkProps) {
  const [limit, setLimit] = useState(maxLines);
  const collapsed = decision === "kept" || decision === "reverted";
  const shown = lines.slice(0, limit);
  const remaining = lines.length - shown.length;
  return (
    <section
      id={id}
      aria-label={regionLabel}
      className={cx(
        "nv-diff-hunk",
        `nv-diff-hunk--${decision}`,
        current && "nv-diff-hunk--current",
        alwaysShowActions && "nv-diff-hunk--actions-visible",
      )}
    >
      <header className="nv-diff-hunk__header">
        <code className="nv-diff-hunk__range">{header}</code>
        {context ? <span className="nv-diff-hunk__context">{context}</span> : null}
        {decisionPill ? <span className="nv-diff-hunk__pill">{decisionPill}</span> : null}
        {actions ? <span className="nv-diff-hunk__actions">{actions}</span> : null}
      </header>
      {conflict ? <div className="nv-diff-hunk__conflict">{conflict}</div> : null}
      {collapsed ? null : (
        <div className="nv-diff-hunk__lines">
          {shown.map((line, index) => (
            <div key={index} className={cx("nv-diff-line", `nv-diff-line--${line.kind}`)}>
              <span className="nv-diff-line__num" aria-hidden>
                {line.oldNumber ?? ""}
              </span>
              <span className="nv-diff-line__num" aria-hidden>
                {line.newNumber ?? ""}
              </span>
              <span className="nv-diff-line__sign" aria-hidden>
                {SIGNS[line.kind]}
              </span>
              <span className="nv-diff-line__text">
                {line.kind === "add" ? <span className="nv-visually-hidden">{lineLabels.add} </span> : null}
                {line.kind === "del" ? <span className="nv-visually-hidden">{lineLabels.del} </span> : null}
                {line.text}
              </span>
            </div>
          ))}
          {remaining > 0 ? (
            <button type="button" className="nv-diff-hunk__more" onClick={() => setLimit((value) => value + maxLines)}>
              {showMoreLabel(remaining)}
            </button>
          ) : null}
        </div>
      )}
    </section>
  );
}
