import { describe, expect, it, vi } from "vitest";
import { NovaIpcError, type Mission, type MissionLink, type MissionTreeNode, type NovaApi } from "@nova/shared";
import { canDiscard, canIntegrate, createSubmissionsStore, type SubmissionsClient } from "./submissions-slice";

type SubmissionsApi = NovaApi["submissions"];

const mission = (id: string, over: Partial<Mission> = {}): Mission => ({
  id,
  workspaceId: "w",
  conversationId: null,
  title: id,
  goal: "g",
  mode: "build",
  state: "succeeded",
  modelId: "acme/m",
  createdAt: 1,
  startedAt: 1,
  endedAt: 2,
  updatedAt: 2,
  ...over,
});
const link = (child: string, over: Partial<MissionLink> = {}): MissionLink => ({
  childMissionId: child,
  parentMissionId: "parent",
  kind: "submission",
  forkSeq: null,
  depth: 1,
  reservedUsd: 0.1,
  worktree: child,
  integration: "pending",
  createdAt: 1,
  updatedAt: 1,
  ...over,
});
const tree = (children: MissionTreeNode["children"]): MissionTreeNode => ({ mission: mission("parent", { state: "running" }), link: null, children });

function client(overrides: Partial<NovaApi["submissions"]> = {}): SubmissionsClient & { submissions: { [K in keyof NovaApi["submissions"]]: ReturnType<typeof vi.fn> } } {
  return {
    submissions: {
      tree: vi.fn<SubmissionsApi["tree"]>(async () => tree([{ mission: mission("c1"), link: link("c1") }])),
      integrate: vi.fn<SubmissionsApi["integrate"]>(async () => tree([{ mission: mission("c1"), link: link("c1", { integration: "integrated", worktree: null }) }])),
      discard: vi.fn<SubmissionsApi["discard"]>(async () => tree([{ mission: mission("c1"), link: link("c1", { integration: "discarded", worktree: null }) }])),
      ...overrides,
    },
  } as never;
}

describe("submissions slice", () => {
  it("loads a tree, integrates a child and keeps the new state", async () => {
    const api = client();
    const store = createSubmissionsStore(api);
    await store.getState().load("parent");
    expect(store.getState().availability).toBe("available");
    expect(store.getState().trees["parent"]?.children[0]?.link.integration).toBe("pending");
    const result = await store.getState().integrate("c1");
    expect(api.submissions.integrate).toHaveBeenCalledWith({ childMissionId: "c1" });
    expect(result?.children[0]?.link.integration).toBe("integrated");
    expect(store.getState().trees["parent"]?.children[0]?.link.integration).toBe("integrated");
    expect(store.getState().busy).toEqual({});
  });

  it("hides the group when main answers unavailable, and keeps other failures visible", async () => {
    const unavailable = createSubmissionsStore(client({ tree: vi.fn<SubmissionsApi["tree"]>(async () => Promise.reject(new NovaIpcError({ code: "unavailable", message: "x" }))) }));
    await unavailable.getState().load("parent");
    expect(unavailable.getState().availability).toBe("unavailable");

    const broken = createSubmissionsStore(client({ tree: vi.fn<SubmissionsApi["tree"]>(async () => Promise.reject(new NovaIpcError({ code: "internal", message: "x" }))) }));
    await broken.getState().load("parent");
    expect(broken.getState().loadFailed).toEqual({ parent: true });
  });

  it("records a failed action on the child and refreshes the tree", async () => {
    const api = client({ integrate: vi.fn<SubmissionsApi["integrate"]>(async () => Promise.reject(new NovaIpcError({ code: "unavailable", message: "no tests" }))) });
    const store = createSubmissionsStore(api);
    await store.getState().load("parent");
    expect(await store.getState().integrate("c1")).toBeNull();
    expect(store.getState().errors).toEqual({ c1: { action: "integrate", code: "unavailable" } });
    // Loaded once, the group is available: an action refusal never hides it.
    expect(store.getState().availability).toBe("available");
    expect(api.submissions.tree).toHaveBeenCalledTimes(2);
  });

  it("follows mission events: integration updates and children's live state", async () => {
    const store = createSubmissionsStore(client());
    await store.getState().load("parent");
    store.getState().applyMissionEvent({
      id: "e1",
      missionId: "parent",
      seq: 5,
      at: 5,
      type: "submission.updated",
      link: link("c1", { integration: "tests_failed" }),
      childState: "succeeded",
    });
    expect(store.getState().trees["parent"]?.children[0]?.link.integration).toBe("tests_failed");
    store.getState().applyMissionEvent({ id: "e2", missionId: "c1", seq: 9, at: 9, type: "mission.cancelled", by: "user" });
    expect(store.getState().trees["parent"]?.children[0]?.mission.state).toBe("cancelled");
  });

  it("offers integrate and discard only when they can succeed", () => {
    const child = (state: Mission["state"], over: Partial<MissionLink>) => ({ mission: mission("c", { state }), link: link("c", over) });
    expect(canIntegrate(child("succeeded", { integration: "pending" }))).toBe(true);
    expect(canIntegrate(child("succeeded", { integration: "conflict" }))).toBe(true);
    expect(canIntegrate(child("running", { integration: null }))).toBe(false);
    expect(canIntegrate(child("succeeded", { integration: "integrated", worktree: null }))).toBe(false);
    expect(canIntegrate(child("succeeded", { integration: "not_needed", worktree: null }))).toBe(false);
    expect(canDiscard(child("running", { integration: null }))).toBe(true);
    expect(canDiscard(child("running", { integration: "not_needed", worktree: null }))).toBe(true);
    expect(canDiscard(child("succeeded", { integration: "not_needed", worktree: null }))).toBe(false);
    expect(canDiscard(child("succeeded", { integration: "testing" }))).toBe(false);
    expect(canDiscard(child("succeeded", { integration: "integrated", worktree: null }))).toBe(false);
  });
});
