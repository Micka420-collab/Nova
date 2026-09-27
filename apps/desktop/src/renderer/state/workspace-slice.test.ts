import { describe, expect, it } from "vitest";
import type { GitStatus } from "@nova/shared";
import { createFakeAtelierClient, WORKSPACE_ID } from "../components/files/test-client";
import { createAtelierStore } from "./editor-slice";
import { ancestorsOf, gitLettersOf } from "./workspace-slice";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("explorer slice", () => {
  it("binding a workspace lists only the root, lazily", async () => {
    const fake = createFakeAtelierClient({ "src/app.ts": "a", "README.md": "r" });
    const store = createAtelierStore(fake.client);
    await store.getState().explorer.bind(WORKSPACE_ID);
    const { dirs } = store.getState().explorer;
    expect(Object.keys(dirs)).toEqual([""]);
    expect(dirs[""]?.entries.map((entry) => entry.name)).toEqual(["src", "README.md"]);
    store.getState().explorer.toggleDir("src");
    await flush();
    expect(store.getState().explorer.dirs.src?.entries.map((entry) => entry.name)).toEqual(["app.ts"]);
  });

  it("re-lists a shown directory when a file appears in it, and ignores other workspaces", async () => {
    const fake = createFakeAtelierClient({ "src/app.ts": "a" });
    const store = createAtelierStore(fake.client);
    fake.client.files.onEvent((event) => store.getState().explorer.applyFilesEvent(event));
    await store.getState().explorer.bind(WORKSPACE_ID);
    store.getState().explorer.toggleDir("src");
    await flush();
    fake.disk.set("src/new.ts", "n");
    await flush();
    await flush();
    expect(store.getState().explorer.dirs.src?.entries.map((entry) => entry.name)).toEqual(["app.ts", "new.ts"]);
    const listsBefore = fake.callsOf("files.list").length;
    store.getState().explorer.applyFilesEvent({ type: "overflow", workspaceId: "7b2d4e61-0f3a-4c8b-9d5e-1a2b3c4d5e6f" });
    expect(fake.callsOf("files.list")).toHaveLength(listsBefore);
  });

  it("reveal expands and lists every ancestor, then selects the path", async () => {
    const fake = createFakeAtelierClient({ "src/lib/deep.ts": "d" });
    const store = createAtelierStore(fake.client);
    await store.getState().explorer.bind(WORKSPACE_ID);
    await store.getState().explorer.reveal("src/lib/deep.ts");
    const { expanded, dirs, selected } = store.getState().explorer;
    expect(Object.keys(expanded).sort()).toEqual(["src", "src/lib"]);
    expect(dirs["src/lib"]?.status).toBe("ready");
    expect(selected).toBe("src/lib/deep.ts");
  });

  it("maps Git status to tree letters, and shows none when Git is unavailable", () => {
    const status: GitStatus = {
      available: true,
      branch: "main",
      upstream: null,
      ahead: null,
      behind: null,
      truncated: false,
      entries: [
        { path: "m.ts", origPath: null, index: "unmodified", worktree: "modified" },
        { path: "a.ts", origPath: null, index: "added", worktree: "unmodified" },
        { path: "d.ts", origPath: null, index: "unmodified", worktree: "deleted" },
        { path: "u.ts", origPath: null, index: "untracked", worktree: "untracked" },
        { path: "c.ts", origPath: null, index: "conflicted", worktree: "conflicted" },
        { path: "r.ts", origPath: "old.ts", index: "renamed", worktree: "unmodified" },
      ],
    };
    expect(gitLettersOf(status)).toEqual({ "m.ts": "M", "a.ts": "A", "d.ts": "D", "u.ts": "?", "c.ts": "!", "r.ts": "R" });
    expect(gitLettersOf({ available: false })).toEqual({});
  });

  it("lists the ancestors of a path, root first", () => {
    expect(ancestorsOf("a/b/c.ts")).toEqual(["", "a", "a/b"]);
    expect(ancestorsOf("c.ts")).toEqual([""]);
  });
});
