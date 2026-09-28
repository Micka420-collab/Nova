// Five-field cron (minute hour day-of-month month day-of-week), parsed in-house (no dependency,
// J2-B lane map: "cron maison"). Supported per field: `*`, `n`, `a-b`, `*/s`, `a-b/s`, `a/s`,
// comma lists, month names (JAN–DEC) and day names (SUN–SAT); day-of-week 7 = Sunday.
// Day matching follows the classic Vixie rule: when BOTH day-of-month and day-of-week are
// restricted, a day matches if EITHER matches; otherwise the restricted one decides.

export interface CronSpec {
  /** Sorted ascending, deduplicated. */
  minutes: readonly number[];
  hours: readonly number[];
  daysOfMonth: ReadonlySet<number>;
  months: ReadonlySet<number>;
  /** 0 = Sunday … 6 = Saturday. */
  daysOfWeek: ReadonlySet<number>;
  domRestricted: boolean;
  dowRestricted: boolean;
}

export type CronParseResult = { ok: true; spec: CronSpec } | { ok: false; reason: string };

interface FieldDef {
  name: string;
  min: number;
  max: number;
  names?: readonly string[];
}

const FIELDS: readonly FieldDef[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day-of-month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12, names: ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"] },
  { name: "day-of-week", min: 0, max: 7, names: ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"] },
];

class CronFieldError extends Error {}

function parseValue(raw: string, field: FieldDef): number {
  const upper = raw.toUpperCase();
  const named = field.names?.indexOf(upper) ?? -1;
  if (named >= 0) return field.name === "month" ? named + 1 : named;
  if (!/^\d{1,2}$/.test(raw)) throw new CronFieldError(`${field.name}: "${raw}" is not a number`);
  const value = Number(raw);
  if (value < field.min || value > field.max) throw new CronFieldError(`${field.name}: ${value} is outside ${field.min}-${field.max}`);
  return value;
}

function parseField(text: string, field: FieldDef): { values: Set<number>; restricted: boolean } {
  const values = new Set<number>();
  let restricted = true;
  for (const part of text.split(",")) {
    if (part === "") throw new CronFieldError(`${field.name}: empty list item`);
    const [rangeText, stepText, extra] = part.split("/");
    if (extra !== undefined || rangeText === undefined || rangeText === "") throw new CronFieldError(`${field.name}: "${part}" is malformed`);
    let step = 1;
    if (stepText !== undefined) {
      if (!/^\d{1,2}$/.test(stepText) || Number(stepText) < 1) throw new CronFieldError(`${field.name}: step "${stepText}" is invalid`);
      step = Number(stepText);
    }
    let from: number;
    let to: number;
    if (rangeText === "*") {
      from = field.min;
      to = field.max;
      if (stepText === undefined && text === "*") restricted = false;
    } else if (rangeText.includes("-")) {
      const [a, b, more] = rangeText.split("-");
      if (a === undefined || b === undefined || more !== undefined) throw new CronFieldError(`${field.name}: range "${rangeText}" is malformed`);
      from = parseValue(a, field);
      to = parseValue(b, field);
      if (from > to) throw new CronFieldError(`${field.name}: range ${from}-${to} is reversed`);
    } else {
      from = parseValue(rangeText, field);
      // `a/s` = from a to the end of the field, every s.
      to = stepText === undefined ? from : field.max;
    }
    for (let value = from; value <= to; value += step) values.add(field.name === "day-of-week" && value === 7 ? 0 : value);
  }
  return { values, restricted };
}

export function parseCron(expression: string): CronParseResult {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return { ok: false, reason: `expected 5 fields, got ${parts.length}` };
  try {
    const parsed = FIELDS.map((field, index) => parseField(parts[index] ?? "", field));
    const [minute, hour, dom, month, dow] = parsed as [
      ReturnType<typeof parseField>,
      ReturnType<typeof parseField>,
      ReturnType<typeof parseField>,
      ReturnType<typeof parseField>,
      ReturnType<typeof parseField>,
    ];
    return {
      ok: true,
      spec: {
        minutes: [...minute.values].sort((a, b) => a - b),
        hours: [...hour.values].sort((a, b) => a - b),
        daysOfMonth: dom.values,
        months: month.values,
        daysOfWeek: dow.values,
        domRestricted: dom.restricted,
        dowRestricted: dow.restricted,
      },
    };
  } catch (error) {
    if (error instanceof CronFieldError) return { ok: false, reason: error.message };
    throw error;
  }
}

/** Whether the local calendar day (month 1–12, weekday 0 = Sunday) matches the spec. */
export function cronMatchesDay(spec: CronSpec, day: { month: number; day: number; weekday: number }): boolean {
  if (!spec.months.has(day.month)) return false;
  const dom = spec.daysOfMonth.has(day.day);
  const dow = spec.daysOfWeek.has(day.weekday);
  if (spec.domRestricted && spec.dowRestricted) return dom || dow;
  if (spec.domRestricted) return dom;
  if (spec.dowRestricted) return dow;
  return true;
}
