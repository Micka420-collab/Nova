import type { ComponentPropsWithRef, ReactNode } from "react";
import { cx } from "../cx";

export interface StatusBarProps {
  /** Accessible name of the bar. */
  label: string;
  start?: ReactNode;
  end?: ReactNode;
  className?: string;
}

/** Full-width bar at the bottom of the workshop (VISUAL.md §3). */
export function StatusBar({ label, start, end, className }: StatusBarProps) {
  return (
    <footer aria-label={label} className={cx("nv-statusbar", className)}>
      <div className="nv-statusbar__group">{start}</div>
      <div className="nv-statusbar__group nv-statusbar__group--end">{end}</div>
    </footer>
  );
}

export interface StatusBarItemProps extends ComponentPropsWithRef<"button"> {
  tone?: "neutral" | "amber" | "danger" | "jade";
}

/** A button when it does something, plain text otherwise (no inert button). */
export function StatusBarItem({ tone = "neutral", className, onClick, type, disabled, children, ...rest }: StatusBarItemProps) {
  const classes = cx("nv-statusbar__item", `nv-statusbar__item--${tone}`, className);
  if (onClick) {
    return (
      <button {...rest} type={type ?? "button"} disabled={disabled} onClick={onClick} className={classes}>
        {children}
      </button>
    );
  }
  const { id, title, "aria-label": ariaLabel } = rest;
  return (
    <span id={id} title={title} aria-label={ariaLabel} className={classes}>
      {children}
    </span>
  );
}
