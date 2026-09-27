import type { ComponentPropsWithRef } from "react";
import { cx } from "../cx";
import { OrbitIndicator } from "./OrbitIndicator";

export type BadgeTone = "neutral" | "jade" | "amber" | "danger";

export interface BadgeProps extends ComponentPropsWithRef<"span"> {
  tone?: BadgeTone;
}

export function Badge({ tone = "neutral", className, ...rest }: BadgeProps) {
  return <span {...rest} className={cx("nv-badge", `nv-tone--${tone}`, className)} />;
}

export interface StatusPillProps extends ComponentPropsWithRef<"span"> {
  tone?: BadgeTone;
  /** Swaps the status dot for the moving orbit; only for an operation actually in progress. */
  active?: boolean;
}

/** A status label with a leading marker. The text carries the meaning; color only reinforces it. */
export function StatusPill({ tone = "neutral", active = false, className, children, ...rest }: StatusPillProps) {
  return (
    <span {...rest} className={cx("nv-pill", `nv-tone--${tone}`, className)}>
      {active ? <OrbitIndicator active size={12} /> : <span className="nv-pill__dot" aria-hidden />}
      {children}
    </span>
  );
}
