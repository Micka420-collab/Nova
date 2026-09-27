import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openNovaStore } from "../nova-store";
import type { NovaStore } from "../types";
import { createCheckpointRepo } from "./checkpoints";
import { createWorkspaceRepo } from "./workspaces";

let store: NovaStore;
let clock = 0;
const now = (): number => (clock += 1);
const h = (char: string): string => char.repeat(64);

beforeEach(() => {
  clock = 1000;
  store = openNovaStore(":memory:");
});
afterEach(() => store.close());

describe("checkpoint repo", () => {
  it("keeps the first before_hash when a path is written twice in one checkpoint", () => {
    const workspace = createWorkspaceRepo(store.db, now).upsertByRootPath({ rootPath: "/w", name: "w" });
    const repo = createCheckpointRepo(store.db, now);
    const checkpoint = repo.createCheckpoint({ workspaceId: workspace.id, missionId: null, label: "Étape 1", reason: "tool_write" });
    repo.upsertFile({ checkpointId: checkpoint.id, path: "src/a.ts", beforeHash: h("a"), afterHash: h("b"), userHashSeen: null });
    repo.upsertFile({ checkpointId: checkpoint.id, path: "src/a.ts", beforeHash: h("b"), afterHash: h("c"), userHashSeen: null });
    repo.upsertFile({ checkpointId: checkpoint.id, path: "new.ts", beforeHash: null, afterHash: h("d"), userHashSeen: h("e") });

    expect(repo.get(checkpoint.id)?.files).toEqual([
      { checkpointId: checkpoint.id, path: "new.ts", beforeHash: null, afterHash: h("d"), userHashSeen: h("e") },
      { checkpointId: checkpoint.id, path: "src/a.ts", beforeHash: h("a"), afterHash: h("c"), userHashSeen: null },
    ]);
    expect(repo.referencedHashes()).toEqual(new Set([h("a"), h("c"), h("d"), h("e")]));
  });

  it("lists newest first, filters by mission, and deletes with their files", () => {
    const workspace = createWorkspaceRepo(store.db, now).upsertByRootPath({ rootPath: "/w", name: "w" });
    const repo = createCheckpointRepo(store.db, now);
    const mission = "00000000-0000-4000-8000-000000000001";
    const first = repo.createCheckpoint({ workspaceId: workspace.id, missionId: mission, label: "1", reason: "tool_write" });
    const second = repo.createCheckpoint({ workspaceId: workspace.id, missionId: null, label: "2", reason: "manual" });
    repo.upsertFile({ checkpointId: first.id, path: "a", beforeHash: h("a"), afterHash: null, userHashSeen: null });

    expect(repo.list({ workspaceId: workspace.id, missionId: null, limit: 10 }).map((c) => c.id)).toEqual([second.id, first.id]);
    expect(repo.list({ workspaceId: workspace.id, missionId: mission, limit: 10 }).map((c) => c.id)).toEqual([first.id]);
    expect(repo.listAges().map((entry) => entry.id)).toEqual([first.id, second.id]);

    repo.deleteCheckpoints([first.id]);
    expect(repo.get(first.id)).toBeNull();
    expect(repo.referencedHashes().size).toBe(0);
  });
});
