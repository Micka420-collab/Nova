import { cloneElement, useEffect, useId, useState, type FocusEvent, type ReactElement, type ReactNode } from "react";
import { cx } from "../cx";

interface TriggerProps {
  "aria-describedby"?: string;
  onFocus?: (event: FocusEvent<HTMLElement>) => void;
  onBlur?: (event: FocusEvent<HTMLElement>) => void;
}

export interface TooltipProps {
  content: ReactNode;
  /** A single focusable element (button, link...). */
  children: ReactElement<TriggerProps>;
  side?: "top" | "bottom";
  /** Hover delay; keyboard focus shows the tooltip immediately. */
  delayMs?: number;
}

/** Supplementary description: shown on hover and focus, hoverable, dismissed with Escape (WCAG 1.4.13). */
export function Tooltip({ content, children, side = "top", delayMs = 400 }: TooltipProps) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [hovered, setHovered] = useState(false);

  useEffect(() => {
    if (!hovered) return;
    const timer = setTimeout(() => setOpen(true), delayMs);
    return () => clearTimeout(timer);
  }, [hovered, delayMs]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  function hide() {
    setHovered(false);
    setOpen(false);
  }

  const trigger = cloneElement(children, {
    "aria-describedby": cx(children.props["aria-describedby"], id),
    onFocus: (event: FocusEvent<HTMLElement>) => {
      children.props.onFocus?.(event);
      setOpen(true);
    },
    onBlur: (event: FocusEvent<HTMLElement>) => {
      children.props.onBlur?.(event);
      hide();
    },
  });

  return (
    <span className="nv-tooltip-anchor" onPointerEnter={() => setHovered(true)} onPointerLeave={hide}>
      {trigger}
      <span role="tooltip" id={id} className={cx("nv-tooltip", `nv-tooltip--${side}`)} hidden={!open}>
        {content}
      </span>
    </span>
  );
}
