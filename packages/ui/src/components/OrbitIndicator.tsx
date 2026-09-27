import { cx, svgA11y } from "../cx";

export interface OrbitIndicatorProps {
  /** True only while a real operation runs; the orbit stays still otherwise. */
  active?: boolean;
  size?: number;
  /** Accessible name; decorative (aria-hidden) without one. */
  label?: string;
  className?: string;
}

/** NOVA's signature: an open orbit with a small satellite. */
export function OrbitIndicator({ active = false, size = 16, label, className }: OrbitIndicatorProps) {
  return (
    <svg
      className={cx("nv-orbit", active && "nv-orbit--active", className)}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      focusable="false"
      {...svgA11y(label)}
    >
      <g className="nv-orbit__spin">
        <path className="nv-orbit__arc" d="M19.79 7.5A9 9 0 1 1 13.56 3.14" />
        <circle className="nv-orbit__dot" cx="17.16" cy="4.63" r="2.3" />
      </g>
    </svg>
  );
}
