// J2-B repos (migration v6): skills, schedules and runs, mission links, compaction summaries and
// timeline search. Each test states the invariant a lane builds on.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MissionContractInput } from "@nova/shared";
import { openNovaStore } from "../nova-store";
import type { NovaStore } from "../types";
import { createCompactionRepo } from "./compaction";
import { createMissionLinkRepo } from "./mission-links";
import { createMissionRepo, type MissionRepo } from "./missions";
import { createScheduleRepo } from "./schedules";
import { createSkillRepo } from "./skills";
import { createTimelineSearchRepo, toFtsQuery } from "./timeline";
import { createWorkspaceRepo } from "./workspaces";

let store: NovaStore;
let clock: number;
let missions: MissionRepo;
let workspaceId: string;
const now = (): number => (clock += 1);

const CONTRACT: MissionContractInput = {
  profile: "read_only",
  allowedOperations: ["read"],
  allowedHosts: [],
  webSearch: false,
  maxDurationMs: 60_000,
  budgetUsd: 0.1,
};

function newMission(title = "t"): string {
  return missions.create({
    workspaceId,
    conversationId: null,
    title,
    goal: "g",
    mode: "fix",
    modelId: "acme/m",
    contract: { profile: "assisted", isolationLevel: "L0", allowedOperations: ["read"], allowedHosts: [], maxDurationMs: 60_000, budgetUsd: 0.5 },
  }).id;
}

beforeEach(() => {
  clock = 1_000;
  store = openNovaStore(":memory:");
  workspaceId = createWorkspaceRepo(store.db, now).upsertByRootPath({ rootPath: "/p", name: "p" }).id;
  missions = createMissionRepo(store.db, now);
});
afterEach(() => store.close());

describe("skill repo", () => {
  const skill = {
    name: "ecrire-des-tests",
    description: "Écrire des tests utiles",
    version: "1.0.0",
    declared: { tools: ["run_tests"], hosts: [], scripts: ["scripts/check.sh"] },
    contentHash: "a".repeat(64),
    fileCount: 2,
    totalBytes: 900,
    installDir: "ecrire-des-tests",
  };

  it("replaces an install in place and uninstalls without leaving an enablement behind", () => {
    const skills = createSkillRepo(store.db, now);
    const first = skills.upsertInstalled(skill);
    const second = skills.upsertInstalled({ ...skill, version: "1.1.0" });
    expect(second).toMatchObject({ version: "1.1.0", installedAt: first.installedAt });
    expect(second.updatedAt).toBeGreaterThan(first.updatedAt);

    skills.setEnabled(workspaceId, "user:ecrire-des-tests", true, skill.contentHash);
    skills.setEnabled(workspaceId, "builtin:comprendre-un-depot", true, null);
    expect(skills.listEnablements(workspaceId).map((row) => row.ref)).toEqual(["builtin:comprendre-un-depot", "user:ecrire-des-tests"]);

    expect(skills.uninstall("ecrire-des-tests")).toBe(true);
    expect(skills.getInstalled("ecrire-des-tests")).toBeNull();
    expect(skills.listEnablements(workspaceId).map((row) => row.ref)).toEqual(["builtin:comprendre-un-depot"]);
    expect(skills.uninstall("ecrire-des-tests")).toBe(false);
  });

  it("refuses a malformed reference and forgets enablements with their workspace", () => {
    const skills = createSkillRepo(store.db, now);
    expect(() => skills.setEnabled(workspaceId, "plugin:x" as "user:x", true, null)).toThrow(/CHECK constraint failed/);
    expect(skills.setEnabled(workspaceId, "project:release", false, "b".repeat(64))).toMatchObject({ enabled: false });
    store.db.prepare("DELETE FROM workspaces WHERE id = ?").run(workspaceId);
    expect(skills.listEnablements(workspaceId)).toEqual([]);
  });
});

describe("schedule repo", () => {
  const input = () => ({
    workspaceId,
    title: "Tests de nuit",
    goal: "Lancer les tests",
    mode: "verify" as const,
    modelId: "acme/m",
    contract: CONTRACT,
    trigger: { kind: "daily" as const, time: "03:00", timeZone: "Europe/Paris" },
    missedPolicy: "skip" as const,
    nextRunAt: 5_000,
  });

  it("round-trips a schedule, lists the due ones and pauses without losing the template", () => {
    const schedules = createScheduleRepo(store.db, now);
    const created = schedules.create(input());
    expect(created).toMatchObject({ state: "active", nextRunAt: 5_000, lastRunAt: null, contract: CONTRACT });
    expect(schedules.listDue(4_999)).toEqual([]);
    expect(schedules.listDue(5_000).map((row) => row.id)).toEqual([created.id]);
    expect(schedules.setState(created.id, "paused", null)).toMatchObject({ state: "paused", nextRunAt: null });
    expect(schedules.listDue(10_000)).toEqual([]);
    const updated = schedules.update(created.id, { trigger: { kind: "interval", everyMinutes: 30 } }, 9_000);
    expect(updated).toMatchObject({ trigger: { kind: "interval", everyMinutes: 30 }, goal: "Lancer les tests", nextRunAt: 9_000 });
    expect(schedules.update("missing", {}, null)).toBeNull();
  });

  it("records every run with its outcome, links the mission and keeps the history bounded", () => {
    const schedules = createScheduleRepo(store.db, now);
    const schedule = schedules.create(input());
    const skipped = schedules.insertRun({ scheduleId: schedule.id, dueAt: 1, outcome: "skipped_missed" });
    expect(skipped).toMatchObject({ outcome: "skipped_missed", missionId: null, startedAt: null });
    expect(skipped.endedAt).not.toBeNull();

    const run = schedules.insertRun({ scheduleId: schedule.id, dueAt: 2, outcome: "running" });
    const missionId = newMission();
    expect(schedules.startRun(run.id, missionId)).toMatchObject({ missionId, outcome: "running" });
    expect(schedules.listRunning().map((row) => row.id)).toEqual([run.id]);
    expect(schedules.runOfMission(missionId)?.id).toBe(run.id);
    expect(schedules.finishRun(run.id, "succeeded")).toMatchObject({ outcome: "succeeded" });
    expect(schedules.listRunning()).toEqual([]);

    for (let due = 3; due < 8; due += 1) schedules.insertRun({ scheduleId: schedule.id, dueAt: due, outcome: "skipped_overlap" });
    expect(schedules.pruneRuns(schedule.id, 3)).toBe(4);
    expect(schedules.listRuns(schedule.id, 10).map((row) => row.dueAt)).toEqual([7, 6, 5]);

    // A deleted mission leaves the run in the history, without its link.
    const other = schedules.insertRun({ scheduleId: schedule.id, dueAt: 9, outcome: "running", missionId });
    store.db.prepare("DELETE FROM missions WHERE id = ?").run(missionId);
    expect(schedules.listRuns(schedule.id, 1)[0]).toMatchObject({ id: other.id, missionId: null });
    expect(schedules.remove(schedule.id)).toBe(true);
    expect(schedules.listRuns(schedule.id, 10)).toEqual([]);
  });

  it("rejects the discuss mode and an unknown missed-run policy", () => {
    const schedules = createScheduleRepo(store.db, now);
    expect(() => schedules.create({ ...input(), mode: "discuss" as "verify" })).toThrow(/CHECK constraint failed/);
    expect(() => schedules.create({ ...input(), missedPolicy: "catch_up_all" as "skip" })).toThrow(/CHECK constraint failed/);
  });
});

describe("mission link repo", () => {
  it("links sub-missions and forks, one origin per child, in creation order", () => {
    const links = createMissionLinkRepo(store.db, now);
    const parent = newMission("parent");
    const childA = newMission("a");
    const childB = newMission("b");
    links.insert({ childMissionId: childA, parentMissionId: parent, kind: "submission", forkSeq: null, depth: 1, reservedUsd: 0.1, worktree: "wt-a", integration: "pending" });
    links.insert({ childMissionId: childB, parentMissionId: parent, kind: "fork", forkSeq: 3, depth: 1, reservedUsd: null, worktree: null, integration: null });
    expect(links.listChildren(parent).map((link) => link.childMissionId)).toEqual([childA, childB]);
    expect(links.listChildren(parent, "fork").map((link) => link.childMissionId)).toEqual([childB]);
    expect(() =>
      links.insert({ childMissionId: childA, parentMissionId: parent, kind: "submission", forkSeq: null, depth: 1, reservedUsd: 0, worktree: null, integration: null }),
    ).toThrow(/UNIQUE constraint failed/);
    expect(links.setIntegration(childA, "integrated")).toMatchObject({ integration: "integrated" });
    expect(links.get(parent)).toBeNull();
  });

  it("refuses a self link and a fork without its event", () => {
    const links = createMissionLinkRepo(store.db, now);
    const mission = newMission();
    const other = newMission();
    expect(() =>
      links.insert({ childMissionId: mission, parentMissionId: mission, kind: "submission", forkSeq: null, depth: 1, reservedUsd: 0, worktree: null, integration: null }),
    ).toThrow(/CHECK constraint failed/);
    expect(() =>
      links.insert({ childMissionId: other, parentMissionId: mission, kind: "fork", forkSeq: null, depth: 1, reservedUsd: null, worktree: null, integration: null }),
    ).toThrow(/CHECK constraint failed/);
  });
});

describe("compaction repo", () => {
  const base = {
    kind: "compaction" as const,
    reason: "proposed" as const,
    summary: "Résumé",
    summarizerModelId: "acme/m",
    fromModelId: null,
    toModelId: null,
    coveredUntilSeq: 12,
    tokensBefore: 90_000,
    tokensAfter: 8_000,
    pruned: [{ toolCallId: "c1", tool: "run_tests", originalChars: 40_000, keptChars: 3_000, artifactId: null }],
    costUsd: null,
  };

  it("starts proposed, is decided once, and the latest applied summary wins", () => {
    const repo = createCompactionRepo(store.db, now);
    const missionId = newMission();
    const target = { kind: "mission" as const, missionId };
    const first = repo.insert({ ...base, target });
    expect(first).toMatchObject({ status: "proposed", decidedAt: null, target, pruned: base.pruned });
    expect(repo.latestApplied(target)).toBeNull();
    expect(repo.decide(first.id, "applied")).toMatchObject({ status: "applied" });
    expect(repo.decide(first.id, "dismissed")).toBeNull();
    const second = repo.insert({ ...base, target, reason: "manual" });
    repo.decide(second.id, "applied");
    expect(repo.latestApplied(target)?.id).toBe(second.id);
    expect(repo.list(target).map((row) => row.id)).toEqual([first.id, second.id]);
  });

  it("keeps a handoff dossier with its summary and scopes conversations apart", () => {
    const repo = createCompactionRepo(store.db, now);
    const missionId = newMission();
    const handoff = repo.insert(
      { ...base, target: { kind: "mission", missionId }, kind: "handoff", reason: "model_switch", toModelId: "acme/n" },
      { missionId, fromModelId: "acme/m", toModelId: "acme/n", goal: "g", done: ["a"], remaining: ["b"], decisions: [], filesTouched: ["src/a.ts"], openQuestions: [] },
    );
    expect(repo.dossier(handoff.id)).toMatchObject({ summaryId: handoff.id, toModelId: "acme/n", filesTouched: ["src/a.ts"] });
    const conversationId = store.createConversation({ title: "c", modelId: null }).id;
    const chat = repo.insert({ ...base, target: { kind: "conversation", conversationId } });
    expect(repo.list({ kind: "conversation", conversationId }).map((row) => row.id)).toEqual([chat.id]);
    expect(repo.dossier(chat.id)).toBeNull();
    // A handoff needs a mission and a dossier (CHECK constraints).
    expect(() => repo.insert({ ...base, target: { kind: "conversation", conversationId }, kind: "handoff" }, null)).toThrow(/CHECK constraint failed/);
  });
});

describe("timeline search", () => {
  it("finds stored events accent-insensitively, scoped, and forgets deleted missions", () => {
    const search = createTimelineSearchRepo(store.db);
    const a = newMission("Panier");
    const b = newMission("Facture");
    missions.appendEvent(a, "mission.failed", { reason: "acceptance_failed", detail: "Échec du test panier" });
    missions.appendEvent(b, "mission.succeeded", { summary: "Facture corrigée" });
    expect(search.search({ query: "echec", workspaceId: null, missionId: null, limit: 10 })).toMatchObject([
      { missionId: a, missionTitle: "Panier", type: "mission.failed" },
    ]);
    expect(search.search({ query: "factu", workspaceId, missionId: null, limit: 10 }).map((hit) => hit.missionId)).toEqual([b]);
    expect(search.search({ query: "factu", workspaceId: null, missionId: a, limit: 10 })).toEqual([]);
    // FTS syntax in user text is inert.
    expect(search.search({ query: 'NEAR( " OR * detail:', workspaceId: null, missionId: null, limit: 10 })).toEqual([]);
    store.db.prepare("DELETE FROM workspaces WHERE id = ?").run(workspaceId);
    expect(search.search({ query: "echec", workspaceId: null, missionId: null, limit: 10 })).toEqual([]);
    expect(store.db.prepare("SELECT count(*) AS n FROM mission_events_fts").get()?.["n"]).toBe(0);
  });

  it("quotes every term", () => {
    expect(toFtsQuery("  ")).toBeNull();
    expect(toFtsQuery('a "b" c')).toBe('"a" "b" "c"*');
  });
});

describe("mission model (A15 handoff)", () => {
  it("switches the model of a mission and ignores an unknown one", () => {
    const missionId = newMission();
    expect(missions.setModel(missionId, "acme/next")).toMatchObject({ modelId: "acme/next" });
    expect(missions.setModel("missing", "acme/next")).toBeNull();
  });
});
