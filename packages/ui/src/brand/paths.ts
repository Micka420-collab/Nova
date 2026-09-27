/*
 * Brand geometry, shared by the React components and the hand-authored files in packages/ui/assets
 * (brand-assets.test.ts keeps them in sync). All shapes are strokes with round caps and joins.
 */

/** Mark: an "N" whose last stem sweeps into an open orbit, with a moon resting in the opening. */
export const MARK_VIEWBOX = "0 0 64 64";
export const MARK_PATH = "M22 45V21L40 45V18C40 10.5 36.5 6 32 6A26 26 0 1 0 58 32";
export const MARK_STROKE = 6;
export const MARK_MOON = { cx: 50.4, cy: 13.6, r: 4.5 } as const;

/** Wordmark "NOVA": rounded N joints, ring O, V with a soft bottom, crossbar-less A (Λ). */
export const WORDMARK_WIDTH = 153;
export const WORDMARK_HEIGHT = 48;
export const WORDMARK_VIEWBOX = `0 0 ${WORDMARK_WIDTH} ${WORDMARK_HEIGHT}`;
export const WORDMARK_PATH =
  "M2.5 42V6L27.5 42V6M59.6 5.4A18.6 18.6 0 1 1 59.6 42.6A18.6 18.6 0 1 1 59.6 5.4Z" +
  "M90.7 6L102.6 39.54Q104.7 45.46 106.8 39.54L118.7 6M122.37 42L134.27 8.46Q136.37 2.54 138.47 8.46L150.37 42";
export const WORDMARK_STROKE = 5;

/** Lockup: mark at full height, wordmark scaled so its cap height centers on the orbit. */
export const LOCKUP_WIDTH = 191;
export const LOCKUP_VIEWBOX = `0 0 ${LOCKUP_WIDTH} 64`;
export const LOCKUP_WORDMARK_TRANSFORM = "translate(80 14.72) scale(0.72)";
