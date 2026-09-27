import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openNovaStore } from "../nova-store";
import type { NovaStore } from "../types";
import { createArtifactRepo } from "./artifacts";
import { createWorkspaceRepo } from "./workspaces";

let store: NovaStore;
let clock = 0;
beforeEach(() => {
  clock = 0;
  store = openNovaStore(":memory:");
});
afterEach(() => store.close());

describe("artifact repo", () => {
  it("indexes artifacts by workspace and mission, newest first", () => {
    const workspace = createWorkspaceRepo(store.db).upsertByRootPath({ rootPath: "/w", name: "w" });
    const repo = createArtifactRepo(store.db, () => (clock += 1));
    const base = { workspaceId: workspace.id, missionId: "m1", kind: "log" as const, mime: "text/plain", sizeBytes: 3 };
    const first = repo.create({ ...base, title: "pnpm test", contentHash: "a".repeat(64) });
    const second = repo.create({ ...base, title: "pnpm build", contentHash: "b".repeat(64) });
    expect(repo.listByMission("m1").map((artifact) => artifact.id)).toEqual([second.id, first.id]);
    expect(repo.listByWorkspace(workspace.id)).toHaveLength(2);
    expect(repo.get(first.id)).toEqual(first);
    expect(repo.delete(first.id)).toBe(true);
    expect(repo.referencedHashes()).toEqual(new Set(["b".repeat(64)]));
    expect(() => repo.create({ ...base, kind: "video" as never, title: "x", contentHash: "c".repeat(64) })).toThrow(/CHECK constraint/);
  });
});
