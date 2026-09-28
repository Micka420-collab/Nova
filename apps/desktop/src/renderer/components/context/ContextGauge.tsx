// L2 — how full the model's context is. Real figures only: the provider's report, or an estimate
// said to be one, or « inconnu ». Past the proposal threshold, offers a summary (never applied
// without the user's decision).
import { Button } from "@nova/ui";
import { COMPACTION_PROPOSAL_RATIO, type ContextUsage } from "@nova/shared";
import { CONTEXT_SOURCE_LABELS, contextCopy } from "../../copy/fr-context";
import { formatInteger } from "../../lib/format";
// Side-effect import: the stylesheet ships with the component (emitted as a file, CSP-safe).
// oxlint-disable-next-line import/no-unassigned-import
import "./context.css";

const copy = contextCopy.gauge;

export interface ContextGaugeProps {
  usage: ContextUsage | null;
  /** Offered only when a summary can be asked for now; absent = no button. */
  onCompact?: () => void;
  compacting?: boolean;
}

function percent(ratio: number): string {
  return formatInteger(Math.round(Math.min(ratio, 9.99) * 100));
}

export function ContextGauge({ usage, onCompact, compacting = false }: ContextGaugeProps) {
  const ratio = usage?.ratio ?? null;
  const used = usage?.usedTokens ?? null;
  const total = usage?.contextLength ?? null;
  const value =
    ratio !== null
      ? copy.percent(percent(ratio))
      : used !== null
        ? copy.tokensNoTotal(formatInteger(used))
        : copy.unknown;
  const detail =
    used !== null && total !== null ? copy.tokens(formatInteger(used), formatInteger(total)) : null;
  const due = usage?.proposalDue ?? false;
  return (
    <div className="nova-context-gauge">
      <div className="nova-context-gauge__row">
        <span className="nova-context-gauge__label">{copy.label}</span>
        <span className="nova-context-gauge__value">
          {value}
          {usage && usage.source !== "unknown" ? ` · ${CONTEXT_SOURCE_LABELS[usage.source]}` : null}
        </span>
      </div>
      {ratio !== null ? (
        <div className="nova-context-gauge__track">
          <meter
            className={`nova-context-gauge__meter${due ? " nova-context-gauge__meter--due" : ""}`}
            aria-label={copy.label}
            aria-valuetext={detail ?? value}
            min={0}
            max={1}
            value={Math.min(ratio, 1)}
          />
          <span className="nova-context-gauge__threshold" style={{ left: `${COMPACTION_PROPOSAL_RATIO * 100}%` }} aria-hidden />
        </div>
      ) : null}
      {detail ? <p className="nova-note">{detail}</p> : null}
      {usage && total === null ? <p className="nova-note">{copy.unknownLength}</p> : null}
      {due ? <p className="nova-note">{copy.due}</p> : null}
      {due && onCompact ? (
        <span>
          <Button size="sm" variant="secondary" loading={compacting} onClick={onCompact}>
            {compacting ? copy.compacting : copy.compact}
          </Button>
        </span>
      ) : null}
    </div>
  );
}
