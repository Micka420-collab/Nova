// Mission links (J2-B L5 sub-missions, L8 forks): one origin per child, children in creation order,
// integration and worktree updates. The invariants the submissions controller builds on.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openNovaStore } from "../nova-store";
import type { NovaStore } from "../types";
import { createMissionLinkRepo, type MissionLinkRepo } from "./mission-links";
import { createMissionRepo, type MissionRepo } from "./missions";
import { createWorkspaceRepo } from "./workspaces";

let store: NovaStore;
let clock: number;
let missions: MissionRepo;
let links: MissionLinkRepo;
let workspaceId: string;
const now = (): number => (clock += 1);

function newMission(): string {
  return missions.create({
    workspaceId,
    conversationId: null,
    title: "t",
    goal: "g",
    mode: "build",
    modelId: "acme/m",
    contract: { profile: "assisted", isolationLevel: "L0", allowedOperations: ["read"], allowedHosts: [], maxDurationMs: 60_000, budgetUsd: 0.5 },
  }).id;
}

function submission(parent: string, child: string, reservedUsd = 0.1) {
  return links.insert({
    childMissionId: child,
    parentMissionId: parent,
    kind: "submission",
    forkSeq: null,
    depth: 1,
    reservedUsd,
    worktree: null,
    integration: "not_needed",
  });
}

beforeEach(() => {
  clock = 1_000;
  store = openNovaStore(":memory:");
  workspaceId = createWorkspaceRepo(store.db, now).upsertByRootPath({ rootPath: "/p", name: "p" }).id;
  missions = createMissionRepo(store.db, now);
  links = createMissionLinkRepo(store.db, now);
});
afterEach(() => store.close());

describe("mission link repo", () => {
  it("stores a sub-mission link and reads it back by child", () => {
    const parent = newMission();
    const child = newMission();
    const link = submission(parent, child, 0.25);
    expect(link).toEqual({
      childMissionId: child,
      parentMissionId: parent,
      kind: "submission",
      forkSeq: null,
      depth: 1,
      reservedUsd: 0.25,
      worktree: null,
      integration: "not_needed",
      createdAt: link.createdAt,
      updatedAt: link.createdAt,
    });
    expect(links.get(child)).toEqual(link);
    expect(links.get(parent)).toBeNull();
  });

  it("refuses a second origin for the same child and a self link", () => {
    const parent = newMission();
    const child = newMission();
    submission(parent, child);
    expect(() => submission(newMission(), child)).toThrow(/UNIQUE constraint failed/);
    expect(() => submission(parent, parent)).toThrow(/CHECK constraint failed/);
  });

  it("lists children oldest first, filtered by kind", () => {
    const parent = newMission();
    const first = newMission();
    const second = newMission();
    const fork = newMission();
    submission(parent, first);
    submission(parent, second);
    links.insert({ childMissionId: fork, parentMissionId: parent, kind: "fork", forkSeq: 3, depth: 1, reservedUsd: null, worktree: null, integration: null });
    expect(links.listChildren(parent, "submission").map((link) => link.childMissionId)).toEqual([first, second]);
    expect(links.listChildren(parent).map((link) => link.childMissionId)).toEqual([first, second, fork]);
    expect(links.listChildren(first)).toEqual([]);
  });

  it("updates integration and worktree, stamping updatedAt; unknown child = null", () => {
    const parent = newMission();
    const child = newMission();
    const created = submission(parent, child);
    const withTree = links.setWorktree(child, child);
    expect(withTree?.worktree).toBe(child);
    const testing = links.setIntegration(child, "testing");
    expect(testing?.integration).toBe("testing");
    expect(testing?.updatedAt).toBeGreaterThan(created.updatedAt);
    expect(links.setWorktree(child, null)?.worktree).toBeNull();
    expect(links.setIntegration("missing", "integrated")).toBeNull();
  });

  it("lists the sub-missions left to settle: running, awaiting integration, or with a worktree", () => {
    const parent = newMission();
    const [running, pending, done, withTree, readOnly, fork] = [newMission(), newMission(), newMission(), newMission(), newMission(), newMission()];
    links.insert({ childMissionId: running, parentMissionId: parent, kind: "submission", forkSeq: null, depth: 1, reservedUsd: 0.1, worktree: running, integration: null });
    submission(parent, pending);
    links.setIntegration(pending, "tests_failed");
    submission(parent, done);
    links.setIntegration(done, "integrated");
    submission(parent, withTree);
    links.setIntegration(withTree, "discarded");
    links.setWorktree(withTree, withTree);
    submission(parent, readOnly);
    links.insert({ childMissionId: fork, parentMissionId: parent, kind: "fork", forkSeq: 2, depth: 1, reservedUsd: null, worktree: null, integration: null });
    expect(links.listUnsettled().map((link) => link.childMissionId)).toEqual([running, pending, withTree]);
  });

  it("disappears with its child mission (no orphan link)", () => {
    const parent = newMission();
    const child = newMission();
    submission(parent, child);
    store.db.prepare("DELETE FROM missions WHERE id = ?").run(child);
    expect(links.get(child)).toBeNull();
    expect(links.listChildren(parent)).toEqual([]);
  });
});
