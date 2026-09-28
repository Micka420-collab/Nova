import { describe, expect, it } from "vitest";
import type { FileWriteRequest } from "@nova/shared";
import { createFakeAtelierClient, sha256, WORKSPACE_ID } from "../components/files/test-client";
import { createAtelierStore, memorySessionStore, TextDoc, type AtelierStore, type EditorSessionStore } from "./editor-slice";

const OTHER_WORKSPACE = "7b2d4e61-0f3a-4c8b-9d5e-1a2b3c4d5e6f";
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

async function setup(files: Record<string, string>, sessions?: EditorSessionStore) {
  const fake = createFakeAtelierClient(files);
  const store = createAtelierStore(fake.client, sessions ? { sessions } : {});
  const unsubscribe = fake.client.files.onEvent((event) => {
    store.getState().explorer.applyFilesEvent(event);
    store.getState().editor.applyFilesEvent(event);
  });
  await store.getState().explorer.bind(WORKSPACE_ID);
  return { fake, store, unsubscribe };
}

const editor = (store: AtelierStore) => store.getState().editor;
const tab = (store: AtelierStore, path: string) => editor(store).tabs.find((item) => item.path === path);
const bufferText = (store: AtelierStore, path: string) => editor(store).buffers.get(path)?.snapshot().text;

/** What typing does, without CodeMirror: a new buffer and the dirty flip reported by the surface. */
function type(store: AtelierStore, path: string, text: string) {
  const base = (editor(store).buffers.get(path) as TextDoc).base;
  editor(store).buffers.set(path, new TextDoc(text, base));
  editor(store).setDirty(path, text !== base);
}

function writes(fake: ReturnType<typeof createFakeAtelierClient>): FileWriteRequest[] {
  return fake.callsOf("files.write") as FileWriteRequest[];
}

describe("editor slice: open and save", () => {
  it("opens a file as a clean tab based on the disk hash", async () => {
    const { store } = await setup({ "src/app.ts": "export const a = 1;\n" });
    await editor(store).openFile("src/app.ts");
    expect(tab(store, "src/app.ts")).toMatchObject({
      status: "ready",
      kind: "text",
      dirty: false,
      baseHash: sha256("export const a = 1;\n"),
    });
    expect(editor(store).activePath).toBe("src/app.ts");
    expect(bufferText(store, "src/app.ts")).toBe("export const a = 1;\n");
  });

  it("saves with the hash it last saw and keeps the file's CRLF line endings", async () => {
    const original = "a\r\nb\r\n";
    const { fake, store } = await setup({ "win.txt": original });
    await editor(store).openFile("win.txt");
    expect(bufferText(store, "win.txt")).toBe("a\nb\n");
    type(store, "win.txt", "a\nb\nc\n");
    expect(await editor(store).save("win.txt")).toBe(true);
    expect(writes(fake).at(-1)).toMatchObject({ content: "a\r\nb\r\nc\r\n", expectedHash: sha256(original) });
    expect(fake.disk.get("win.txt")).toBe("a\r\nb\r\nc\r\n");
    expect(tab(store, "win.txt")).toMatchObject({ dirty: false, baseHash: sha256("a\r\nb\r\nc\r\n") });
  });

  it("never overwrites a file changed on disk since it was opened: the save ends in a conflict", async () => {
    const { fake, store } = await setup({ "a.ts": "one\n" });
    await editor(store).openFile("a.ts");
    fake.disk.set("a.ts", "agent version\n", false);
    type(store, "a.ts", "user version\n");
    expect(await editor(store).save("a.ts")).toBe(false);
    expect(fake.disk.get("a.ts")).toBe("agent version\n");
    expect(tab(store, "a.ts")?.conflict).toEqual({ diskHash: sha256("agent version\n"), diskContent: "agent version\n" });
    expect(bufferText(store, "a.ts")).toBe("user version\n");
    // Ctrl+S cannot pick a side while the conflict is shown.
    expect(await editor(store).save("a.ts")).toBe(false);
  });

  it("its own save echoed by the watcher is not a conflict", async () => {
    const { store } = await setup({ "a.ts": "one\n" });
    await editor(store).openFile("a.ts");
    type(store, "a.ts", "two\n");
    await editor(store).save("a.ts");
    await flush();
    await flush();
    expect(tab(store, "a.ts")).toMatchObject({ conflict: null, dirty: false, version: 1 });
  });
});

describe("editor slice: external changes", () => {
  it("reloads a clean buffer when the file changes on disk", async () => {
    const { fake, store } = await setup({ "a.ts": "one\n" });
    await editor(store).openFile("a.ts");
    fake.disk.set("a.ts", "two\n");
    await flush();
    await flush();
    expect(bufferText(store, "a.ts")).toBe("two\n");
    expect(tab(store, "a.ts")).toMatchObject({ version: 2, dirty: false, conflict: null, baseHash: sha256("two\n") });
  });

  it("keeps unsaved edits and raises a conflict when the file changes under them", async () => {
    const { fake, store } = await setup({ "a.ts": "one\n" });
    await editor(store).openFile("a.ts");
    type(store, "a.ts", "mine\n");
    fake.disk.set("a.ts", "theirs\n");
    await flush();
    await flush();
    expect(bufferText(store, "a.ts")).toBe("mine\n");
    expect(tab(store, "a.ts")?.conflict).toEqual({ diskHash: sha256("theirs\n"), diskContent: "theirs\n" });
  });

  it("resolves a conflict by reloading the disk version or by knowingly keeping mine", async () => {
    const { fake, store } = await setup({ "a.ts": "one\n", "b.ts": "one\n" });
    for (const path of ["a.ts", "b.ts"]) {
      await editor(store).openFile(path);
      type(store, path, "mine\n");
      fake.disk.set(path, "theirs\n");
    }
    await flush();
    await flush();

    await editor(store).reloadFromDisk("a.ts");
    expect(bufferText(store, "a.ts")).toBe("theirs\n");
    expect(tab(store, "a.ts")).toMatchObject({ conflict: null, dirty: false });

    await editor(store).keepMine("b.ts");
    expect(writes(fake).at(-1)).toMatchObject({ path: "b.ts", content: "mine\n", expectedHash: sha256("theirs\n") });
    expect(fake.disk.get("b.ts")).toBe("mine\n");
    expect(tab(store, "b.ts")).toMatchObject({ conflict: null, dirty: false });
  });

  it("applies a merge result as an unsaved buffer over the disk version", async () => {
    const { fake, store } = await setup({ "a.ts": "one\n" });
    await editor(store).openFile("a.ts");
    type(store, "a.ts", "mine\n");
    fake.disk.set("a.ts", "theirs\n");
    await flush();
    await flush();
    editor(store).applyMerged("a.ts", "theirs\nmine\n");
    expect(bufferText(store, "a.ts")).toBe("theirs\nmine\n");
    expect(tab(store, "a.ts")).toMatchObject({ conflict: null, dirty: true, baseHash: sha256("theirs\n") });
    await editor(store).save("a.ts");
    expect(fake.disk.get("a.ts")).toBe("theirs\nmine\n");
  });

  it("marks a clean tab deleted on disk and recreates the file on save", async () => {
    const { fake, store } = await setup({ "a.ts": "one\n" });
    await editor(store).openFile("a.ts");
    fake.disk.delete("a.ts");
    await flush();
    expect(tab(store, "a.ts")).toMatchObject({ deletedOnDisk: true, baseHash: null, conflict: null });
    await editor(store).save("a.ts");
    expect(writes(fake).at(-1)).toMatchObject({ expectedHash: null, content: "one\n" });
    expect(fake.disk.get("a.ts")).toBe("one\n");
  });

  it("a deletion under unsaved edits is a conflict, never a silent loss", async () => {
    const { fake, store } = await setup({ "a.ts": "one\n" });
    await editor(store).openFile("a.ts");
    type(store, "a.ts", "mine\n");
    fake.disk.delete("a.ts");
    await flush();
    expect(tab(store, "a.ts")?.conflict).toEqual({ diskHash: null, diskContent: null });
    expect(bufferText(store, "a.ts")).toBe("mine\n");
  });
});

describe("editor slice: tabs", () => {
  it("refuses to close a tab with unsaved edits unless forced, then activates the neighbor", async () => {
    const { store } = await setup({ "a.ts": "a", "b.ts": "b", "c.ts": "c" });
    for (const path of ["a.ts", "b.ts", "c.ts"]) await editor(store).openFile(path);
    editor(store).activate("b.ts");
    type(store, "b.ts", "edited");
    expect(editor(store).closeTab("b.ts")).toBe(false);
    expect(editor(store).tabs).toHaveLength(3);
    expect(editor(store).closeTab("b.ts", true)).toBe(true);
    expect(editor(store).activePath).toBe("c.ts");
    expect(editor(store).buffers.has("b.ts")).toBe(false);
    await editor(store).reopenClosed();
    expect(editor(store).activePath).toBe("b.ts");
    expect(bufferText(store, "b.ts")).toBe("b");
  });

  it("keeps pinned tabs first and never moves a tab across the pinned boundary", async () => {
    const { store } = await setup({ "a.ts": "a", "b.ts": "b", "c.ts": "c" });
    for (const path of ["a.ts", "b.ts", "c.ts"]) await editor(store).openFile(path);
    editor(store).setPinned("c.ts", true);
    expect(editor(store).tabs.map((item) => item.path)).toEqual(["c.ts", "a.ts", "b.ts"]);
    editor(store).moveTab("b.ts", 0);
    expect(editor(store).tabs.map((item) => item.path)).toEqual(["c.ts", "b.ts", "a.ts"]);
    editor(store).closeOthers("a.ts");
    expect(editor(store).tabs.map((item) => item.path)).toEqual(["c.ts", "a.ts"]);
  });

  it("cycles tabs in most-recently-used order with Ctrl+Tab and in strip order with Ctrl+PageDown", async () => {
    const { store } = await setup({ "a.ts": "a", "b.ts": "b", "c.ts": "c" });
    for (const path of ["a.ts", "b.ts", "c.ts"]) await editor(store).openFile(path);
    editor(store).activate("a.ts");
    editor(store).cycleRecent(1);
    expect(editor(store).activePath).toBe("c.ts");
    editor(store).cycleOrder(1);
    expect(editor(store).activePath).toBe("a.ts");
  });

  it("tabs follow a renamed folder", async () => {
    const { store } = await setup({ "src/a.ts": "a" });
    await editor(store).openFile("src/a.ts");
    editor(store).renamePath("src", "lib");
    expect(editor(store).activePath).toBe("lib/a.ts");
    expect(bufferText(store, "lib/a.ts")).toBe("a");
  });

  it("focus is claimed once per user request, never again by a remount", async () => {
    const { store } = await setup({ "a.ts": "a" });
    await editor(store).openFile("a.ts");
    const seq = editor(store).focusSeq;
    expect(editor(store).claimFocus(seq)).toBe(true);
    expect(editor(store).claimFocus(seq)).toBe(false);
    await editor(store).openFile("a.ts", { focus: false });
    expect(editor(store).focusSeq).toBe(seq);
  });
});

describe("editor slice: user closes and tab jumps", () => {
  it("a close of a tab with unsaved edits asks through pendingClose; closing the active tab hands focus to its neighbor", async () => {
    const { store } = await setup({ "a.ts": "a", "b.ts": "b" });
    await editor(store).openFile("a.ts");
    await editor(store).openFile("b.ts");
    type(store, "b.ts", "edited");
    editor(store).requestClose("b.ts");
    expect(editor(store).pendingClose).toBe("b.ts");
    expect(tab(store, "b.ts")).toBeDefined();
    editor(store).cancelClose();
    type(store, "b.ts", "b");
    const seq = editor(store).focusSeq;
    editor(store).requestClose("b.ts");
    expect(editor(store).activePath).toBe("a.ts");
    expect(editor(store).focusSeq).toBe(seq + 1);
  });

  it("Alt+9 is the last tab and Alt+1…8 the tab at that position, wherever the key is pressed", async () => {
    const files = Object.fromEntries(Array.from({ length: 10 }, (_, index) => [`f${index}.ts`, String(index)]));
    const { store } = await setup(files);
    for (const path of Object.keys(files)) await editor(store).openFile(path);
    expect(editor(store).goToTab(8)).toBe(true);
    expect(editor(store).activePath).toBe("f9.ts");
    expect(editor(store).goToTab(1)).toBe(true);
    expect(editor(store).activePath).toBe("f1.ts");
  });
});

describe("editor slice: session per workspace (Pr3)", () => {
  it("re-reads the tabs of a workspace brought back: changes made while it was parked are shown", async () => {
    const { fake, store } = await setup({ "README.md": "old" });
    await editor(store).openFile("README.md");
    await store.getState().explorer.bind(OTHER_WORKSPACE);
    fake.disk.set("README.md", "pulled");
    await flush();
    await store.getState().explorer.bind(WORKSPACE_ID);
    await flush();
    expect(bufferText(store, "README.md")).toBe("pulled");
  });

  it("counts unsaved edits of parked workspaces too (quit guard)", async () => {
    const { store } = await setup({ "a.ts": "a" });
    await editor(store).openFile("a.ts");
    type(store, "a.ts", "unsaved");
    await store.getState().explorer.bind(OTHER_WORKSPACE);
    expect(editor(store).tabs).toEqual([]);
    expect(editor(store).hasUnsaved()).toBe(true);
  });

  it("switching workspaces and back restores tabs and unsaved buffers", async () => {
    const { store } = await setup({ "a.ts": "a" });
    await editor(store).openFile("a.ts");
    type(store, "a.ts", "unsaved");
    await store.getState().explorer.bind(OTHER_WORKSPACE);
    expect(editor(store).tabs).toEqual([]);
    await store.getState().explorer.bind(WORKSPACE_ID);
    expect(tab(store, "a.ts")?.dirty).toBe(true);
    expect(bufferText(store, "a.ts")).toBe("unsaved");
  });

  it("restores the saved tabs of a workspace and reads only the active one", async () => {
    const sessions = memorySessionStore();
    await sessions.save(WORKSPACE_ID, {
      version: 1,
      tabs: [
        { path: "a.ts", pinned: false },
        { path: "b.ts", pinned: true },
      ],
      activePath: "a.ts",
      scroll: { "a.ts": 120 },
    });
    const { fake, store } = await setup({ "a.ts": "a", "b.ts": "b" }, sessions);
    expect(editor(store).tabs.map((item) => [item.path, item.status])).toEqual([
      ["b.ts", "idle"],
      ["a.ts", "ready"],
    ]);
    expect(editor(store).scroll.get("a.ts")).toBe(120);
    expect((fake.callsOf("files.read") as { path: string }[]).map((request) => request.path)).toEqual(["a.ts"]);
  });
});
