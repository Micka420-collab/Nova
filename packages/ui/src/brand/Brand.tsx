import { cx, svgA11y } from "../cx";
import {
  LOCKUP_MARK_TRANSFORM,
  LOCKUP_VIEWBOX,
  LOCKUP_WIDTH,
  LOCKUP_WORDMARK_TRANSFORM,
  MARK_PATH,
  MARK_VIEWBOX,
  WORDMARK_HEIGHT,
  WORDMARK_PATH,
  WORDMARK_STROKE,
  WORDMARK_VIEWBOX,
  WORDMARK_WIDTH,
} from "./paths";

/** "brand" paints the mark with the theme accent; "current" follows the surrounding text color. */
export type BrandTone = "brand" | "current";

export interface LogoMarkProps {
  size?: number;
  tone?: BrandTone;
  /** Accessible name; the mark is decorative (aria-hidden) without one. */
  label?: string;
  className?: string;
}

function MarkShape() {
  return <path d={MARK_PATH} fill="currentColor" />;
}

function WordmarkShape() {
  return (
    <path
      d={WORDMARK_PATH}
      fill="none"
      stroke="currentColor"
      strokeWidth={WORDMARK_STROKE}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  );
}

export function LogoMark({ size = 32, tone = "brand", label, className }: LogoMarkProps) {
  return (
    <svg
      className={cx("nv-logo-mark", tone === "brand" && "nv-brand-accent", className)}
      width={size}
      height={size}
      viewBox={MARK_VIEWBOX}
      focusable="false"
      {...svgA11y(label)}
    >
      <MarkShape />
    </svg>
  );
}

export interface WordmarkProps {
  /** Rendered height in px; width follows the wordmark proportions. */
  height?: number;
  label?: string;
  className?: string;
}

export function Wordmark({ height = 20, label = "NOVA", className }: WordmarkProps) {
  return (
    <svg
      className={cx("nv-wordmark", className)}
      width={(height * WORDMARK_WIDTH) / WORDMARK_HEIGHT}
      height={height}
      viewBox={WORDMARK_VIEWBOX}
      focusable="false"
      {...svgA11y(label)}
    >
      <WordmarkShape />
    </svg>
  );
}

export interface LockupProps {
  height?: number;
  tone?: BrandTone;
  label?: string;
  className?: string;
}

export function Lockup({ height = 32, tone = "brand", label = "NOVA", className }: LockupProps) {
  return (
    <svg
      className={cx("nv-lockup", className)}
      width={(height * LOCKUP_WIDTH) / 64}
      height={height}
      viewBox={LOCKUP_VIEWBOX}
      focusable="false"
      {...svgA11y(label)}
    >
      <g className={tone === "brand" ? "nv-brand-accent" : undefined} transform={LOCKUP_MARK_TRANSFORM}>
        <MarkShape />
      </g>
      <g transform={LOCKUP_WORDMARK_TRANSFORM}>
        <WordmarkShape />
      </g>
    </svg>
  );
}
