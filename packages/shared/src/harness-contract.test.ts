// J2-B shared contract: tool names, skill references, schedule triggers, mission options, chat
// payloads and the IPC surface every lane codes against.
import { describe, expect, it } from "vitest";
import {
  BUILTIN_TOOL_NAMES,
  ChatSendRequestSchema,
  DEFAULT_SETTINGS,
  HARNESS_GROUPS,
  HARNESS_MISSION_EVENT_TYPES,
  IPC_CHANNELS,
  LIVE_ONLY_MISSION_EVENTS,
  MissionContractInputSchema,
  MissionForkRequestSchema,
  OPT_IN_TOOL_NAMES,
  PUSH_CHANNELS,
  ScheduleCreateRequestSchema,
  SettingsPatchSchema,
  SkillRefSchema,
  SkillPreviewRequestSchema,
  TimelineSearchRequestSchema,
  isIanaTimeZone,
  missionHarnessOf,
  skillRef,
} from "./index";

const ID = "7f1c1b8e-7a8f-4d7c-9a51-1c2c3d4e5f60";
const CONTRACT = {
  profile: "assisted",
  allowedOperations: ["read", "write"],
  allowedHosts: [],
  webSearch: false,
  maxDurationMs: 60_000,
  budgetUsd: 0.5,
};

describe("J2-B tool names", () => {
  it("appends the new tools after the J2-A ones (prompt cache) and keeps the provider name limit", () => {
    expect(BUILTIN_TOOL_NAMES.indexOf("fetch_page")).toBe(14);
    expect(BUILTIN_TOOL_NAMES.slice(15)).toEqual([
      "process_list",
      "process_output",
      "process_stop",
      "skill",
      "run_chain",
      "start_submission",
    ]);
    for (const name of BUILTIN_TOOL_NAMES) expect(name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    for (const name of OPT_IN_TOOL_NAMES) expect(BUILTIN_TOOL_NAMES).toContain(name);
  });
});

describe("mission options", () => {
  it("defaults every J2-B option to off and bounds the opt-ins", () => {
    expect(missionHarnessOf({})).toEqual({ chain: false, autoContinue: null, subMissions: null });
    expect(MissionContractInputSchema.safeParse(CONTRACT).success).toBe(true);
    const harness = { chain: true, autoContinue: { maxRounds: 3, budgetUsd: 0.2 }, subMissions: { maxChildren: 2 } };
    expect(MissionContractInputSchema.safeParse({ ...CONTRACT, harness }).success).toBe(true);
    expect(MissionContractInputSchema.safeParse({ ...CONTRACT, harness: { ...harness, autoContinue: { maxRounds: 11, budgetUsd: 0 } } }).success).toBe(false);
    expect(MissionContractInputSchema.safeParse({ ...CONTRACT, harness: { ...harness, subMissions: { maxChildren: 5 } } }).success).toBe(false);
  });

  it("lists every J2-B event once; only context usage is live-only among them", () => {
    expect(new Set(HARNESS_MISSION_EVENT_TYPES).size).toBe(HARNESS_MISSION_EVENT_TYPES.length);
    expect(HARNESS_MISSION_EVENT_TYPES.filter((type) => LIVE_ONLY_MISSION_EVENTS.includes(type))).toEqual(["context.usage"]);
  });
});

describe("skills", () => {
  it("accepts Agent Skills names only, with a known scope", () => {
    expect(skillRef("builtin", "comprendre-un-depot")).toBe("builtin:comprendre-un-depot");
    for (const ok of ["user:a", "project:release-2", "builtin:x9"]) expect(SkillRefSchema.safeParse(ok).success).toBe(true);
    for (const bad of ["user:", "user:A", "user:-a", "user:a--b", "user:a-", "plugin:a", "user:../x", `user:${"a".repeat(65)}`]) {
      expect(SkillRefSchema.safeParse(bad).success).toBe(false);
    }
    // The renderer never sends a path: the folder comes from main's picker.
    expect(SkillPreviewRequestSchema.safeParse({ source: { kind: "picker" } }).success).toBe(true);
    expect(SkillPreviewRequestSchema.safeParse({ source: { kind: "folder", path: "/tmp/x" } }).success).toBe(false);
  });
});

describe("schedules", () => {
  const base = { workspaceId: ID, title: "Nuit", goal: "Tests", mode: "verify", modelId: "a/b", contract: CONTRACT, missedPolicy: "skip" };

  it.each([
    [{ kind: "once", at: 1_000 }, true],
    [{ kind: "interval", everyMinutes: 1 }, true],
    [{ kind: "interval", everyMinutes: 0 }, false],
    [{ kind: "daily", time: "03:00", timeZone: "Europe/Paris" }, true],
    [{ kind: "daily", time: "24:00", timeZone: "Europe/Paris" }, false],
    [{ kind: "daily", time: "03:00", timeZone: "Europe/Nowhere" }, false],
    [{ kind: "weekly", days: [1, 5], time: "09:30", timeZone: "America/New_York" }, true],
    [{ kind: "weekly", days: [], time: "09:30", timeZone: "UTC" }, false],
    [{ kind: "cron", expression: "*/15 9-18 * * 1-5", timeZone: "Asia/Tokyo" }, true],
    [{ kind: "cron", expression: "* * *", timeZone: "UTC" }, false],
  ])("trigger %j valid: %s", (trigger, valid) => {
    expect(ScheduleCreateRequestSchema.safeParse({ ...base, trigger }).success).toBe(valid);
  });

  it("refuses discuss (no mission) and implicit missed-run policies", () => {
    const trigger = { kind: "interval", everyMinutes: 5 };
    expect(ScheduleCreateRequestSchema.safeParse({ ...base, trigger, mode: "discuss" }).success).toBe(false);
    expect(ScheduleCreateRequestSchema.safeParse({ ...base, trigger, missedPolicy: undefined }).success).toBe(false);
    expect(isIanaTimeZone("UTC")).toBe(true);
    expect(isIanaTimeZone("../etc")).toBe(false);
  });
});

describe("desktop, chat and timeline payloads", () => {
  it("adds the J2-B settings with explicit, conservative defaults", () => {
    expect(DEFAULT_SETTINGS.desktop.keepRunningOnClose).toBe(false);
    expect(DEFAULT_SETTINGS.onboarding.profile).toBeNull();
    expect(DEFAULT_SETTINGS.chat.autopilot).toBe(false);
    expect(SettingsPatchSchema.safeParse({ display: { density: "result" } }).success).toBe(true);
    expect(SettingsPatchSchema.safeParse({ display: { density: "tout" } }).success).toBe(false);
    expect(SettingsPatchSchema.safeParse({ desktop: { keepRunningOnClose: true, extra: 1 } }).success).toBe(false);
  });

  it("bounds pasted images and the reasoning effort of one message", () => {
    const send = { conversationId: null, content: "Que montre cette capture ?", modelId: "a/b" };
    const image = { mediaType: "image/png", dataBase64: "iVBORw0KGgo=", name: null };
    expect(ChatSendRequestSchema.safeParse({ ...send, images: [image], reasoningEffort: "low" }).success).toBe(true);
    expect(ChatSendRequestSchema.safeParse({ ...send, images: [{ ...image, mediaType: "image/svg+xml" }] }).success).toBe(false);
    expect(ChatSendRequestSchema.safeParse({ ...send, images: Array(5).fill(image) }).success).toBe(false);
    expect(ChatSendRequestSchema.safeParse({ ...send, reasoningEffort: "max" }).success).toBe(false);
  });

  it("validates timeline search and fork requests", () => {
    expect(TimelineSearchRequestSchema.safeParse({ workspaceId: null, missionId: null, query: "panier", limit: 50 }).success).toBe(true);
    expect(TimelineSearchRequestSchema.safeParse({ workspaceId: null, missionId: null, query: " ", limit: 50 }).success).toBe(false);
    expect(MissionForkRequestSchema.safeParse({ missionId: ID, atSeq: 0, goal: null, modelId: null }).success).toBe(false);
  });

  it("declares a channel for every J2-B group and pushes on the four event channels", () => {
    const channels = Object.values(IPC_CHANNELS);
    for (const group of HARNESS_GROUPS) expect(channels.some((channel) => channel.startsWith(`nova:${group}:`))).toBe(true);
    for (const push of [IPC_CHANNELS.processesEvent, IPC_CHANNELS.contextEvent, IPC_CHANNELS.schedulesEvent, IPC_CHANNELS.desktopEvent]) {
      expect(PUSH_CHANNELS).toContain(push);
    }
  });
});
