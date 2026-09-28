import { useEffect, useRef, useState, type RefObject } from "react";
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
import {
  NOMI_ACTIVITY_LABELS,
  NOMI_STATE_LABELS,
  nomiAccessory,
  type NomiAccessory,
  type NomiActivity,
  type NomiState,
} from "./states";

export interface NomiProps {
  /** Must mirror a real runtime state: Nomi never animates without an actual event behind it. */
  state: NomiState;
  /** Real tool activity (NOMI.md §6); an accessory is held only in thinking/working. */
  activity?: NomiActivity;
  /** `waiting` flavor: an approval to answer (raised brow, pulse) or a suspended mission (still). */
  waiting?: "active" | "suspended";
  /** A file is dragged over Nomi: the pocket shows and Nomi looks at it. */
  dragOver?: boolean;
  /** Quiet mode: half-closed eyes, no animation. */
  quiet?: boolean;
  /**
   * Single focus (VISUAL.md §8): only the "lead" instance on screen animates; a "static" one
   * keeps the same pose without motion.
   */
  presence?: "lead" | "static";
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

/** Reading glasses around the eyes (NOMI.md §8), inside the head so they follow its pose. */
function Glasses() {
  return (
    <g className="nv-nomi__accessory nv-nomi__glasses" data-accessory="glasses">
      <circle cx="27" cy="30.2" r="4.6" />
      <circle cx="37.4" cy="30.2" r="4.6" />
      <path d="M31.6 30.2H32.8" />
      <path d="M22.4 29.4L17.6 28.4" />
      <path d="M42 29.4L46.8 28.4" />
    </g>
  );
}

/** Accessories held beside the body, between the head and the front ring of the orbit. */
function HeldAccessory({ accessory }: { accessory: Exclude<NomiAccessory, "glasses"> }) {
  if (accessory === "tool") {
    return (
      <g className="nv-nomi__accessory nv-nomi__tool" data-accessory="tool" transform="translate(50.5 45)">
        <g className="nv-nomi__tool-swing">
          <rect x="-1.2" y="-6.5" width="2.4" height="11" rx="1.2" />
          <path className="nv-nomi__tool-tip" d="M-1.8 -6.5L0 -10.2L1.8 -6.5Z" />
        </g>
      </g>
    );
  }
  if (accessory === "card") {
    return (
      <g className="nv-nomi__accessory nv-nomi__card" data-accessory="card" transform="translate(9.5 44)">
        <rect x="0" y="0" width="8.5" height="10.5" rx="1.6" />
        <path className="nv-nomi__card-line" d="M2 3H6.5" />
        <path className="nv-nomi__card-line" d="M2 5.5H6.5" />
        <path className="nv-nomi__card-line nv-nomi__card-line--live" d="M2 8H5" />
      </g>
    );
  }
  return (
    <g className="nv-nomi__accessory nv-nomi__probe" data-accessory="probe">
      <path className="nv-nomi__probe-tube" d="M40.5 38.5C46 38.5 46.5 43 44.6 46.2" />
      <g transform="translate(44.6 46.6)">
        <g className="nv-nomi__probe-disc">
          <circle r="2.6" />
          <circle r="1.1" className="nv-nomi__probe-core" />
        </g>
      </g>
    </g>
  );
}

function Pocket() {
  return (
    <g className="nv-nomi__accessory nv-nomi__pocket" data-accessory="pocket" transform="translate(13 45.5)">
      <path d="M0 1.5Q0 0 1.5 0H4L5 1.2H8.5Q10 1.2 10 2.7V8Q10 9.5 8.5 9.5H1.5Q0 9.5 0 8Z" />
    </g>
  );
}

/**
 * Pauses animations while the figure cannot be seen (hidden window, scrolled or collapsed away),
 * NOMI.md §7 budget. The pause freezes the current pose; it is not reduced motion.
 */
function useOffscreenPause(ref: RefObject<SVGSVGElement | null>, enabled: boolean): boolean {
  const [hidden, setHidden] = useState(false);
  const [offscreen, setOffscreen] = useState(false);
  useEffect(() => {
    if (!enabled) return undefined;
    const onVisibility = () => setHidden(document.visibilityState === "hidden");
    onVisibility();
    document.addEventListener("visibilitychange", onVisibility);
    const element = ref.current;
    let observer: IntersectionObserver | null = null;
    if (element && typeof IntersectionObserver !== "undefined") {
      observer = new IntersectionObserver((entries) => {
        const entry = entries.at(-1);
        if (entry) setOffscreen(!entry.isIntersecting);
      });
      observer.observe(element);
    }
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      observer?.disconnect();
    };
  }, [ref, enabled]);
  return enabled && (hidden || offscreen);
}

export function Nomi({
  state,
  activity = "none",
  waiting = "active",
  dragOver = false,
  quiet = false,
  presence = "lead",
  size = 64,
  motion = "full",
  label,
  className,
}: NomiProps) {
  const ref = useRef<SVGSVGElement>(null);
  const animated = motion === "full" && presence === "lead" && !quiet;
  const paused = useOffscreenPause(ref, animated);
  const eye = eyeShapeFor(state);
  const accessory = nomiAccessory(state, activity);
  const defaultLabel = accessory && activity !== "none" ? NOMI_ACTIVITY_LABELS[activity] : NOMI_STATE_LABELS[state];
  return (
    <svg
      ref={ref}
      className={cx(
        "nv-nomi",
        motion === "reduced" && "nv-nomi--reduced-motion",
        presence === "static" && "nv-nomi--static",
        paused && "nv-nomi--paused",
        className,
      )}
      data-state={state}
      data-activity={accessory ? activity : undefined}
      data-waiting={state === "waiting" ? waiting : undefined}
      data-quiet={quiet ? "" : undefined}
      data-drag-over={dragOver ? "" : undefined}
      width={size}
      height={size}
      viewBox={NOMI_VIEWBOX}
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- inline SVG needs role="img" to be one named image
      role="img"
      aria-label={label ?? defaultLabel}
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
              <g className="nv-nomi__top-pose">
                <path className="nv-nomi__pebble nv-nomi__top" d={NOMI_TOP} transform={NOMI_TOP_TILT} />
              </g>
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
              {accessory === "glasses" ? <Glasses /> : null}
              {state === "speaking" ? (
                <ellipse className="nv-nomi__mouth" cx="32.2" cy="35.8" rx="1.7" ry="1.2" />
              ) : null}
            </g>
          </g>
        </g>
        {accessory && accessory !== "glasses" ? <HeldAccessory accessory={accessory} /> : null}
        {dragOver ? <Pocket /> : null}
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
