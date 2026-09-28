// Wall-clock arithmetic in an IANA time zone through Intl only (no dependency). DST rules:
// - a wall time that does not exist (spring-forward gap) resolves to the instant the clocks show
//   after the jump, shifted by the gap (Paris 02:30 on the last Sunday of March → 03:30 CEST);
//   `exact: true` callers skip it instead;
// - a wall time that happens twice (fall-back) resolves to its FIRST occurrence only.

export interface WallTime {
  year: number;
  /** 1–12. */
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterOf(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

/** Local wall time of an instant (seconds dropped). */
export function wallTimeOf(instant: number, timeZone: string): WallTime {
  const fields: Record<string, number> = {};
  for (const part of formatterOf(timeZone).formatToParts(new Date(instant))) {
    if (part.type !== "literal") fields[part.type] = Number(part.value);
  }
  return {
    year: fields["year"] ?? 1970,
    month: fields["month"] ?? 1,
    day: fields["day"] ?? 1,
    // Some engines print midnight as 24 even with h23.
    hour: (fields["hour"] ?? 0) % 24,
    minute: fields["minute"] ?? 0,
  };
}

function asUtc(wall: WallTime): number {
  return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
}

/** Offset (ms, local − UTC) in effect at `instant`. */
function offsetAt(instant: number, timeZone: string): number {
  const floored = Math.floor(instant / 60_000) * 60_000;
  return asUtc(wallTimeOf(floored, timeZone)) - floored;
}

function sameWall(a: WallTime, b: WallTime): boolean {
  return a.year === b.year && a.month === b.month && a.day === b.day && a.hour === b.hour && a.minute === b.minute;
}

/**
 * The instant of a local wall time. With `exact`, a wall time that does not exist returns null;
 * otherwise it is shifted forward by the gap.
 */
export function instantOf(wall: WallTime, timeZone: string, options: { exact?: boolean } = {}): number | null {
  const guess = asUtc(wall);
  // Offsets around the guess: every real zone changes offset at most once within ±1 day here.
  const before = offsetAt(guess - 86_400_000, timeZone);
  const after = offsetAt(guess + 86_400_000, timeZone);
  const candidates = [...new Set([guess - before, guess - after])].sort((a, b) => a - b);
  for (const candidate of candidates) {
    if (sameWall(wallTimeOf(candidate, timeZone), wall)) return candidate;
  }
  // Also try the offset in effect at the guess itself (zones with several changes in two days).
  const direct = guess - offsetAt(guess, timeZone);
  if (sameWall(wallTimeOf(direct, timeZone), wall)) return direct;
  if (options.exact) return null;
  // Gap: the pre-transition offset (the larger one when clocks spring forward) lands after the jump.
  return guess - Math.min(before, after);
}

/** Calendar day `offset` days after (year, month, day), with its weekday (0 = Sunday). */
export function addDays(date: { year: number; month: number; day: number }, offset: number): { year: number; month: number; day: number; weekday: number } {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + offset));
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate(), weekday: shifted.getUTCDay() };
}
