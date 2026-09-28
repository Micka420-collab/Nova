import { describe, expect, it } from "vitest";
import type { ScheduleTrigger } from "@nova/shared";
import { parseCron } from "./cron";
import { checkTrigger, nextRunAt, nextRuns } from "./next-run";

const PARIS = "Europe/Paris";
const iso = (value: number | null) => (value === null ? null : new Date(value).toISOString());
const at = (text: string) => Date.parse(text);

describe("nextRunAt", () => {
  it("once: the instant while it is ahead, then null (a past once completes)", () => {
    const trigger: ScheduleTrigger = { kind: "once", at: at("2026-05-01T10:00:00Z") };
    expect(iso(nextRunAt(trigger, at("2026-05-01T09:59:00Z")))).toBe("2026-05-01T10:00:00.000Z");
    expect(nextRunAt(trigger, at("2026-05-01T10:00:00Z"))).toBeNull();
    expect(checkTrigger(trigger, at("2026-06-01T00:00:00Z"))).toMatchObject({ ok: false, reason: "never_runs" });
  });

  it("interval: anchored on the previous due time", () => {
    const trigger: ScheduleTrigger = { kind: "interval", everyMinutes: 15 };
    expect(nextRuns(trigger, at("2026-05-01T10:00:00Z"), 3).map(iso)).toEqual([
      "2026-05-01T10:15:00.000Z",
      "2026-05-01T10:30:00.000Z",
      "2026-05-01T10:45:00.000Z",
    ]);
  });

  it("daily across the March DST switch in Europe/Paris keeps the wall time", () => {
    const trigger: ScheduleTrigger = { kind: "daily", time: "09:00", timeZone: PARIS };
    // 2026-03-29: clocks go 02:00 → 03:00 (UTC+1 → UTC+2).
    expect(nextRuns(trigger, at("2026-03-27T12:00:00Z"), 3).map(iso)).toEqual([
      "2026-03-28T08:00:00.000Z",
      "2026-03-29T07:00:00.000Z",
      "2026-03-30T07:00:00.000Z",
    ]);
  });

  it("daily at a time inside the spring-forward gap runs once, after the jump", () => {
    const trigger: ScheduleTrigger = { kind: "daily", time: "02:30", timeZone: PARIS };
    expect(nextRuns(trigger, at("2026-03-28T12:00:00Z"), 2).map(iso)).toEqual([
      // 02:30 does not exist on 2026-03-29: 03:30 CEST.
      "2026-03-29T01:30:00.000Z",
      "2026-03-30T00:30:00.000Z",
    ]);
  });

  it("daily at a repeated time in October runs once (first occurrence)", () => {
    const trigger: ScheduleTrigger = { kind: "daily", time: "02:30", timeZone: PARIS };
    // 2026-10-25: clocks go 03:00 → 02:00 (UTC+2 → UTC+1); 02:30 happens at 00:30Z and 01:30Z.
    expect(nextRuns(trigger, at("2026-10-24T12:00:00Z"), 3).map(iso)).toEqual([
      "2026-10-25T00:30:00.000Z",
      "2026-10-26T01:30:00.000Z",
      "2026-10-27T01:30:00.000Z",
    ]);
    // Asked between the two occurrences: the next one is the next day, never the repeat.
    expect(iso(nextRunAt(trigger, at("2026-10-25T00:45:00Z")))).toBe("2026-10-26T01:30:00.000Z");
  });

  it("weekly on several days in the zone's calendar", () => {
    // Monday and Thursday 08:15 in New York; asked on Sunday evening in New York (Monday in UTC).
    const trigger: ScheduleTrigger = { kind: "weekly", days: [4, 1], time: "08:15", timeZone: "America/New_York" };
    expect(nextRuns(trigger, at("2026-06-08T01:00:00Z"), 4).map(iso)).toEqual([
      "2026-06-08T12:15:00.000Z",
      "2026-06-11T12:15:00.000Z",
      "2026-06-15T12:15:00.000Z",
      "2026-06-18T12:15:00.000Z",
    ]);
  });

  it("cron */15 9-18 * * 1-5: working hours of weekdays only", () => {
    const trigger: ScheduleTrigger = { kind: "cron", expression: "*/15 9-18 * * 1-5", timeZone: PARIS };
    // Friday 2026-06-12 18:40 local (16:40Z): next is 18:45, then Monday 09:00.
    expect(nextRuns(trigger, at("2026-06-12T16:40:00Z"), 3).map(iso)).toEqual([
      "2026-06-12T16:45:00.000Z",
      "2026-06-15T07:00:00.000Z",
      "2026-06-15T07:15:00.000Z",
    ]);
  });

  it("cron skips minutes that do not exist in the spring gap and runs a repeated hour once", () => {
    const trigger: ScheduleTrigger = { kind: "cron", expression: "30 * * * *", timeZone: PARIS };
    expect(nextRuns(trigger, at("2026-03-29T00:00:00Z"), 2).map(iso)).toEqual([
      "2026-03-29T00:30:00.000Z", // 01:30 CET
      "2026-03-29T01:30:00.000Z", // 03:30 CEST (02:30 does not exist)
    ]);
    expect(nextRuns(trigger, at("2026-10-24T23:45:00Z"), 3).map(iso)).toEqual([
      "2026-10-25T00:30:00.000Z", // 02:30 CEST
      "2026-10-25T02:30:00.000Z", // 03:30 CET (the repeated 02:30 CET is not run again)
      "2026-10-25T03:30:00.000Z",
    ]);
  });

  it("cron with both day fields restricted matches either (Vixie rule) and names work", () => {
    const trigger: ScheduleTrigger = { kind: "cron", expression: "0 12 1 * SUN", timeZone: "UTC" };
    expect(nextRuns(trigger, at("2026-06-01T13:00:00Z"), 2).map(iso)).toEqual(["2026-06-07T12:00:00.000Z", "2026-06-14T12:00:00.000Z"]);
    expect(iso(nextRunAt(trigger, at("2026-06-28T13:00:00Z")))).toBe("2026-07-01T12:00:00.000Z");
  });

  it("an impossible cron never runs and is reported as such", () => {
    const trigger: ScheduleTrigger = { kind: "cron", expression: "0 0 30 2 *", timeZone: "UTC" };
    expect(nextRunAt(trigger, at("2026-01-01T00:00:00Z"))).toBeNull();
    expect(checkTrigger(trigger, at("2026-01-01T00:00:00Z"))).toMatchObject({ ok: false, reason: "never_runs" });
  });
});

describe("parseCron", () => {
  it.each([
    ["60 * * * *", /minute: 60/],
    ["* 24 * * *", /hour: 24/],
    ["* * 0 * *", /day-of-month: 0/],
    ["* * * 13 *", /month: 13/],
    ["*/0 * * * *", /step/],
    ["5-1 * * * *", /reversed/],
    ["* * * *", /5 fields/],
    ["a * * * *", /not a number/],
    ["1,,2 * * * *", /empty/],
  ])("refuses %s with a reason", (expression, reason) => {
    const parsed = parseCron(expression);
    expect(parsed.ok ? null : parsed.reason).toMatch(reason);
  });

  it("expands steps, ranges, lists and 7 = Sunday", () => {
    const parsed = parseCron("5/20 1-3,22 * JAN-MAR 7");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.spec.minutes).toEqual([5, 25, 45]);
    expect(parsed.spec.hours).toEqual([1, 2, 3, 22]);
    expect([...parsed.spec.months]).toEqual([1, 2, 3]);
    expect([...parsed.spec.daysOfWeek]).toEqual([0]);
    expect(parsed.spec.domRestricted).toBe(false);
    expect(checkTrigger({ kind: "cron", expression: "61 * * * *", timeZone: "UTC" }, 0)).toMatchObject({ ok: false, reason: "invalid_cron" });
  });
});
