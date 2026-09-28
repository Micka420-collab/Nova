// L2 — a compaction summary shown AS a summary (quoted, author named, never as the model's own
// words), with what it covers and costs, the tool outputs shortened to write it, and the explicit
// decision while it is proposed.
import { Badge, Button, type BadgeTone } from "@nova/ui";
import type { CompactionStatus, CompactionSummary } from "@nova/shared";
import { SUMMARY_STATUS_LABELS, contextCopy } from "../../copy/fr-context";
import { formatCost, formatInteger } from "../../lib/format";
// Side-effect import: the stylesheet ships with the component (emitted as a file, CSP-safe).
// oxlint-disable-next-line import/no-unassigned-import
import "./context.css";

const copy = contextCopy.summary;

const STATUS_TONES: Record<CompactionStatus, BadgeTone> = { proposed: "amber", applied: "jade", dismissed: "neutral" };

export interface SummaryCardProps {
  summary: CompactionSummary;
  onApply?: () => void;
  onDismiss?: () => void;
  busy?: boolean;
  /** The proposal can no longer be applied (its mission ended): said, not hidden. */
  expired?: boolean;
}

export function authorOf(summary: Pick<CompactionSummary, "kind" | "summarizerModelId">): string {
  if (summary.kind === "handoff") return copy.writtenByNova;
  return summary.summarizerModelId ? copy.writtenBy(summary.summarizerModelId) : copy.writtenByUnknown;
}

export function SummaryCard({ summary, onApply, onDismiss, busy = false, expired = false }: SummaryCardProps) {
  const cost = formatCost(summary.costUsd);
  const tokens =
    summary.tokensBefore !== null && summary.tokensAfter !== null
      ? copy.tokens(formatInteger(summary.tokensBefore), formatInteger(summary.tokensAfter))
      : null;
  const proposed = summary.status === "proposed";
  return (
    <article className={`nova-context-card nova-context-card--${summary.status}`} aria-label={SUMMARY_STATUS_LABELS[summary.status]}>
      <header className="nova-context-card__head">
        <h3 className="nova-context-card__title">{SUMMARY_STATUS_LABELS[summary.status]}</h3>
        <Badge tone={STATUS_TONES[summary.status]}>{summary.reason === "manual" ? copy.manual : copy.automatic}</Badge>
        <span className="nova-note">{authorOf(summary)}</span>
      </header>
      <p className="nova-note">{copy.notModelSpeech}</p>
      <blockquote className="nova-context-card__summary">{summary.summary}</blockquote>
      <ul className="nova-context-card__facts">
        {tokens ? <li>{tokens}</li> : null}
        <li>{cost !== null ? copy.cost(cost) : copy.costUnknown}</li>
      </ul>
      {summary.pruned.length > 0 ? (
        <div className="nova-context-card__section">
          <p className="nova-note">{copy.pruned}</p>
          <ul className="nova-context-card__list">
            {summary.pruned.map((item) => (
              <li key={item.toolCallId}>{copy.prunedItem(item.tool, formatInteger(item.originalChars), formatInteger(item.keptChars))}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <p className="nova-note">{proposed ? (expired ? copy.expired : copy.willReplace) : summary.status === "applied" ? copy.replaced : null}</p>
      {proposed && !expired && onApply && onDismiss ? (
        <div className="nova-context-card__actions">
          <Button size="sm" variant="primary" loading={busy} onClick={onApply}>
            {copy.apply}
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={onDismiss}>
            {copy.dismiss}
          </Button>
        </div>
      ) : null}
    </article>
  );
}
