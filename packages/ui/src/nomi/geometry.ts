/*
 * Nomi: a small cairn of three soft pebbles with two eyes and a tilted orbit around its waist.
 * 64x64 grid, shared by the component and packages/ui/assets/nomi.svg (see brand-assets.test.ts).
 */
export const NOMI_VIEWBOX = "0 0 64 64";

export const NOMI_BODY =
  "M12 50C12 43.5 20 40 32.5 40C45 40 52 43.8 52 50C52 55.8 44 58.8 32 58.8C20 58.8 12 56 12 50Z";
export const NOMI_HEAD =
  "M16.5 30.5C16.5 23 23.5 18.8 32.5 18.8C41.5 18.8 47.5 23.4 47.5 30" +
  "C47.5 37 40.8 41.6 31.8 41.6C22.8 41.6 16.5 37.4 16.5 30.5Z";
export const NOMI_TOP =
  "M26.5 15.2C26.5 12.4 29.4 10.6 33 10.6C36.6 10.6 39.2 12.4 39.2 15" +
  "C39.2 17.6 36.4 19.2 32.8 19.2C29.2 19.2 26.5 17.8 26.5 15.2Z";
export const NOMI_TOP_TILT = "rotate(7 33 15)";
export const NOMI_EYES = [
  { x: 27, y: 30 },
  { x: 37.4, y: 30 },
] as const;

/** Orbit ellipse: center, radii and tilt. The satellite rides it through a flattened rotation. */
export const NOMI_ORBIT = { cx: 32, cy: 42, rx: 24, ry: 6, tilt: -10 } as const;
export const NOMI_ORBIT_TRANSFORM = `translate(${NOMI_ORBIT.cx} ${NOMI_ORBIT.cy}) rotate(${NOMI_ORBIT.tilt})`;
export const NOMI_RING_BACK = `M${NOMI_ORBIT.rx} 0A${NOMI_ORBIT.rx} ${NOMI_ORBIT.ry} 0 0 0 -${NOMI_ORBIT.rx} 0`;
export const NOMI_RING_FRONT = `M-${NOMI_ORBIT.rx} 0A${NOMI_ORBIT.rx} ${NOMI_ORBIT.ry} 0 0 0 ${NOMI_ORBIT.rx} 0`;
/** Vertical squash turning the circular spin into the orbit ellipse. */
export const NOMI_ORBIT_SQUASH = NOMI_ORBIT.ry / NOMI_ORBIT.rx;
export const NOMI_SATELLITE_R = 2.7;
