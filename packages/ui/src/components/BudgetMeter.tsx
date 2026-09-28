import type { CSSProperties } from "react";
import { cx } from "../cx";

export interface BudgetMeterLabels {
  /** Accessible name. */
  label: string;
  spent: (amount: string) => string;
  reserved: (amount: string) => string;
  cap: (amount: string) => string;
  noCap: string;
  atLeast: string;
  unknownCalls: (count: number) => string;
  suspended: string;
  valueText: (spent: string, cap: string | null, atLeast: boolean) => string;
}

export interface BudgetMeterProps {
  spentUsd: number;
  reservedUsd: number;
  /** null = no cap: the track stays empty, never "100 %". */
  capUsd: number | null;
  /** Calls without a reported cost: the spent amount is a lower bound. */
  unknownCostCalls: number;
  variant: "inline" | "card";
  format: (usd: number) => string;
  labels: BudgetMeterLabels;
  suspended?: boolean;
  className?: string;
}

const WARN_RATIO = 0.8;

function percent(value: number): string {
  return `${Math.max(0, Math.min(100, value * 100)).toFixed(2)}%`;
}

/** Spent / reserved / cap (VISUAL.md §5.8). The three amounts are always named, never mixed. */
export function BudgetMeter({
  spentUsd,
  reservedUsd,
  capUsd,
  unknownCostCalls,
  variant,
  format,
  labels,
  suspended = false,
  className,
}: BudgetMeterProps) {
  const hasCap = capUsd !== null && capUsd > 0;
  const ratio = hasCap ? spentUsd / capUsd : 0;
  const atLeast = unknownCostCalls > 0;
  const spent = format(spentUsd);
  const cap = capUsd !== null ? format(capUsd) : null;
  const tone = !hasCap ? null : ratio >= 1 ? "over" : ratio >= WARN_RATIO ? "warn" : null;
  const style = {
    "--nv-budget-spent": hasCap ? percent(ratio) : "0%",
    "--nv-budget-reserved": hasCap ? percent(Math.min(reservedUsd / capUsd, Math.max(0, 1 - ratio))) : "0%",
  } as CSSProperties;

  const meterProps = {
    role: "meter",
    "aria-label": labels.label,
    "aria-valuemin": 0,
    "aria-valuenow": spentUsd,
    ...(hasCap ? { "aria-valuemax": capUsd } : {}),
    "aria-valuetext": labels.valueText(spent, cap, atLeast),
  } as const;

  const track = (
    <span className="nv-budget__track" aria-hidden style={style}>
      <span className="nv-budget__spent" />
      <span className="nv-budget__reserved" />
    </span>
  );

  if (variant === "inline") {
    return (
      <span {...meterProps} className={cx("nv-budget", "nv-budget--inline", tone && `nv-budget--${tone}`, className)}>
        {track}
        <span className="nv-budget__text" aria-hidden>
          {atLeast ? `${labels.atLeast} ` : ""}
          {cap ? `${spent} / ${cap}` : `${spent} · ${labels.noCap}`}
        </span>
      </span>
    );
  }

  return (
    <div {...meterProps} className={cx("nv-budget", "nv-budget--card", tone && `nv-budget--${tone}`, className)}>
      {track}
      <p className="nv-budget__legend" aria-hidden>
        <span>
          {atLeast ? `${labels.atLeast} ` : ""}
          {labels.spent(spent)}
        </span>
        {reservedUsd > 0 ? <span>{labels.reserved(format(reservedUsd))}</span> : null}
        <span>{cap ? labels.cap(cap) : labels.noCap}</span>
        {atLeast ? <span className="nv-budget__unknown">{labels.unknownCalls(unknownCostCalls)}</span> : null}
        {suspended && tone === "over" ? <span className="nv-pill nv-tone--danger nv-budget__pill">{labels.suspended}</span> : null}
      </p>
    </div>
  );
}
