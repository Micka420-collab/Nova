import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openNovaStore } from "../nova-store";
import type { NovaStore } from "../types";
import { createEditorStateRepo, EDITOR_STATE_MAX_CHARS } from "./editor-state";
import { createWorkspaceRepo } from "./workspaces";

let store: NovaStore;
beforeEach(() => {
  store = openNovaStore(":memory:");
});
afterEach(() => store.close());

describe("editor state repo", () => {
  it("round-trips the layout and refuses oversized states", () => {
    const workspace = createWorkspaceRepo(store.db).upsertByRootPath({ rootPath: "/w", name: "w" });
    const repo = createEditorStateRepo(store.db, () => 42);
    expect(repo.get(workspace.id)).toBeNull();
    const state = { tabs: ["src/a.ts"], active: "src/a.ts" };
    repo.put(workspace.id, state);
    repo.put(workspace.id, { ...state, active: null });
    expect(repo.get(workspace.id)).toEqual({ workspaceId: workspace.id, state: { ...state, active: null }, updatedAt: 42 });
    expect(() => repo.put(workspace.id, "x".repeat(EDITOR_STATE_MAX_CHARS))).toThrow(/too large/);
  });
});
