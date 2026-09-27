import { cx } from "../cx";
import {
  NOMI_BODY,
  NOMI_EYES,
  NOMI_HEAD,
  NOMI_ORBIT,
  NOMI_ORBIT_SQUASH,
  NOMI_ORBIT_TRANSFORM,
  NOMI_RING_BACK,
  NOMI_RING_FRONT,
  NOMI_SATELLITE_R,
  NOMI_TOP,
  NOMI_TOP_TILT,
  NOMI_VIEWBOX,
} from "./geometry";
import { NOMI_STATE_LABELS, type NomiState } from "./states";

export interface NomiProps {
  /** Must mirror a real runtime state: Nomi never animates without an actual event behind it. */
  state: NomiState;
  size?: number;
  /** "reduced" freezes every animation; each state keeps a distinct static pose. */
  motion?: "full" | "reduced";
  /** Overrides the French state label used as the accessible name. */
  label?: string;
  className?: string;
}

type EyeShape = "open" | "closed" | "happy";

function eyeShapeFor(state: NomiState): EyeShape {
  if (state === "offline") return "closed";
  if (state === "success") return "happy";
  return "open";
}

function Eye({ shape }: { shape: EyeShape }) {
  if (shape === "closed") return <path className="nv-nomi__lid" d="M-2.6 0.2Q0 2.4 2.6 0.2" />;
  if (shape === "happy") return <path className="nv-nomi__lid" d="M-2.6 1.4Q0 -2.4 2.6 1.4" />;
  return (
    <>
      <ellipse className="nv-nomi__pupil" rx="2.4" ry="3.3" />
      <circle className="nv-nomi__glint" cx="0.8" cy="-1.3" r="0.85" />
    </>
  );
}

export function Nomi({ state, size = 64, motion = "full", label, className }: NomiProps) {
  const eye = eyeShapeFor(state);
  return (
    <svg
      className={cx("nv-nomi", motion === "reduced" && "nv-nomi--reduced-motion", className)}
      data-state={state}
      width={size}
      height={size}
      viewBox={NOMI_VIEWBOX}
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- inline SVG needs role="img" to be one named image
      role="img"
      aria-label={label ?? NOMI_STATE_LABELS[state]}
      focusable="false"
    >
      <ellipse className="nv-nomi__shadow" cx="32" cy="59.2" rx="15" ry="2" />
      <g className="nv-nomi__figure">
        <g transform={NOMI_ORBIT_TRANSFORM}>
          <path className="nv-nomi__ring nv-nomi__ring--back" d={NOMI_RING_BACK} />
        </g>
        <g className="nv-nomi__breath">
          <path className="nv-nomi__pebble nv-nomi__body" d={NOMI_BODY} />
          <g className="nv-nomi__head-pose">
            <g className="nv-nomi__head">
              <path className="nv-nomi__pebble nv-nomi__face" d={NOMI_HEAD} />
              <path className="nv-nomi__pebble nv-nomi__top" d={NOMI_TOP} transform={NOMI_TOP_TILT} />
              <g className="nv-nomi__gaze-pose">
                <g className="nv-nomi__gaze">
                  {NOMI_EYES.map((position) => (
                    <g key={position.x} transform={`translate(${position.x} ${position.y})`}>
                      <g className="nv-nomi__eye">
                        <Eye shape={eye} />
                      </g>
                    </g>
                  ))}
                </g>
              </g>
              {state === "speaking" ? (
                <ellipse className="nv-nomi__mouth" cx="32.2" cy="35.8" rx="1.7" ry="1.2" />
              ) : null}
            </g>
          </g>
        </g>
        <g transform={NOMI_ORBIT_TRANSFORM}>
          <path className="nv-nomi__ring nv-nomi__ring--front" d={NOMI_RING_FRONT} />
          <g transform={`scale(1 ${NOMI_ORBIT_SQUASH})`}>
            <g className="nv-nomi__orbit-pose">
              <g className="nv-nomi__orbit">
                <g transform={`translate(${NOMI_ORBIT.rx} 0)`}>
                  <g className="nv-nomi__sat-pose">
                    <g className="nv-nomi__sat">
                      <ellipse
                        className="nv-nomi__satellite"
                        rx={NOMI_SATELLITE_R}
                        ry={NOMI_SATELLITE_R / NOMI_ORBIT_SQUASH}
                      />
                    </g>
                  </g>
                </g>
              </g>
            </g>
          </g>
        </g>
      </g>
    </svg>
  );
}
