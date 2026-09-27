import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import type { FileWriteRequest } from "@nova/shared";
import { createAtelierStore, type AtelierStore } from "../../state/editor-slice";
import { createFakeAtelierClient, sha256, WORKSPACE_ID } from "../files/test-client";
import { AtelierProvider } from "./atelier-context";
import { EditorWorkbench } from "./EditorWorkbench";
import { installEditorDomPolyfills } from "./test-dom";

installEditorDomPolyfills();
afterEach(cleanup);

const flush = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));

async function setup(files: Record<string, string>, props: Parameters<typeof EditorWorkbench>[0] = {}) {
  const fake = createFakeAtelierClient(files);
  const store = createAtelierStore(fake.client);
  fake.client.files.onEvent((event) => {
    store.getState().explorer.applyFilesEvent(event);
    store.getState().editor.applyFilesEvent(event);
  });
  await store.getState().explorer.bind(WORKSPACE_ID);
  render(
    <AtelierProvider store={store} client={fake.client}>
      <EditorWorkbench {...props} />
    </AtelierProvider>,
  );
  return { fake, store };
}

async function open(store: AtelierStore, path: string) {
  await act(() => store.getState().editor.openFile(path));
  await flush();
}

function currentView(): EditorView {
  const dom = document.querySelector<HTMLElement>(".cm-editor");
  const view = dom ? EditorView.findFromDOM(dom) : null;
  if (!view) throw new Error("no editor view");
  return view;
}

function typeAtEnd(text: string) {
  const view = currentView();
  act(() => view.dispatch({ changes: { from: view.state.doc.length, insert: text } }));
}

const tabs = () => screen.getAllByRole("tab");

describe("EditorWorkbench", () => {
  it("offers quick open when no file is open", async () => {
    const onQuickOpen = vi.fn<() => void>();
    await setup({ "a.ts": "a" }, { onQuickOpen });
    expect(screen.getByRole("heading", { name: "Ouvre un fichier ou demande à Nomi" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Ouvrir un fichier/ }));
    expect(onQuickOpen).toHaveBeenCalledOnce();
  });

  it("shows open files as tabs; Ctrl+W closes the active one and Ctrl+Shift+T reopens it", async () => {
    const { store } = await setup({ "src/a.ts": "a", "src/b.ts": "b" });
    await open(store, "src/a.ts");
    await open(store, "src/b.ts");
    expect(tabs().map((tab) => tab.getAttribute("aria-label"))).toEqual(["src/a.ts", "src/b.ts"]);
    expect(screen.getByRole("tab", { name: "src/b.ts" }).getAttribute("aria-selected")).toBe("true");
    expect(currentView().state.doc.toString()).toBe("b");

    fireEvent.keyDown(screen.getByRole("tab", { name: "src/b.ts" }), { key: "w", ctrlKey: true });
    await flush();
    expect(tabs().map((tab) => tab.getAttribute("aria-label"))).toEqual(["src/a.ts"]);
    expect(currentView().state.doc.toString()).toBe("a");

    fireEvent.keyDown(currentView().contentDOM, { key: "T", ctrlKey: true, shiftKey: true });
    await flush();
    expect(tabs()).toHaveLength(2);
    expect(store.getState().editor.activePath).toBe("src/b.ts");
  });

  it("moves between tabs with the arrow keys and Ctrl+Tab, and reorders with Ctrl+Shift+PageDown", async () => {
    const { store } = await setup({ "a.ts": "a", "b.ts": "b", "c.ts": "c" });
    for (const path of ["a.ts", "b.ts", "c.ts"]) await open(store, path);
    const first = screen.getByRole("tab", { name: "a.ts" });
    act(() => store.getState().editor.activate("a.ts"));
    fireEvent.keyDown(first, { key: "ArrowRight" });
    expect(store.getState().editor.activePath).toBe("b.ts");
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "b.ts" }));

    fireEvent.keyDown(screen.getByRole("tab", { name: "b.ts" }), { key: "Tab", ctrlKey: true });
    expect(store.getState().editor.activePath).toBe("a.ts");

    fireEvent.keyDown(screen.getByRole("tab", { name: "a.ts" }), { key: "PageDown", ctrlKey: true, shiftKey: true });
    expect(tabs().map((tab) => tab.getAttribute("aria-label"))).toEqual(["b.ts", "a.ts", "c.ts"]);
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "a.ts" }));
  });

  it("typing marks the tab unsaved, Ctrl+S writes with the known hash and announces it", async () => {
    const { fake, store } = await setup({ "app.ts": "const a = 1;\n" });
    await open(store, "app.ts");
    typeAtEnd("const b = 2;\n");
    expect(screen.getByRole("tab", { name: "app.ts, non enregistré" })).toBeTruthy();

    fireEvent.keyDown(currentView().contentDOM, { key: "s", ctrlKey: true });
    await flush();
    const write = fake.callsOf("files.write").at(-1) as FileWriteRequest;
    expect(write).toMatchObject({ content: "const a = 1;\nconst b = 2;\n", expectedHash: sha256("const a = 1;\n") });
    expect(screen.getByRole("tab", { name: "app.ts" })).toBeTruthy();
    expect(screen.getByText("app.ts enregistré")).toBeTruthy();
  });

  it("a disk change under unsaved edits shows the conflict banner; Recharger takes the disk version", async () => {
    const { fake, store } = await setup({ "app.ts": "one\n" });
    await open(store, "app.ts");
    typeAtEnd("mine\n");
    act(() => fake.disk.set("app.ts", "theirs\n"));
    await flush();
    await flush();
    expect(screen.getByText("Le fichier a changé sur le disque")).toBeTruthy();
    expect(currentView().state.doc.toString()).toBe("one\nmine\n");

    fireEvent.click(screen.getByRole("button", { name: "Recharger" }));
    await flush();
    expect(screen.queryByText("Le fichier a changé sur le disque")).toBeNull();
    expect(currentView().state.doc.toString()).toBe("theirs\n");
    expect(screen.getByRole("tab", { name: "app.ts" })).toBeTruthy();
  });

  it("Garder ma version overwrites the disk knowingly", async () => {
    const { fake, store } = await setup({ "app.ts": "one\n" });
    await open(store, "app.ts");
    typeAtEnd("mine\n");
    act(() => fake.disk.set("app.ts", "theirs\n"));
    await flush();
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Garder ma version" }));
    await flush();
    expect(fake.disk.get("app.ts")).toBe("one\nmine\n");
    expect(screen.queryByText("Le fichier a changé sur le disque")).toBeNull();
  });

  it("asks before closing a tab with unsaved edits", async () => {
    const { store } = await setup({ "app.ts": "one\n" });
    await open(store, "app.ts");
    typeAtEnd("x");
    fireEvent.click(screen.getByRole("button", { name: "Fermer app.ts" }));
    const dialog = screen.getByRole("dialog", { name: "Enregistrer les modifications de app.ts ?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Ne pas enregistrer" }));
    await flush();
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
  });

  it("shows binary files and the agent's orbit without opening an editor on them", async () => {
    const { store } = await setup({ "logo.png": "\0PNG", "form.tsx": "x" }, { agentWritingPaths: new Set(["form.tsx"]) });
    await open(store, "logo.png");
    expect(screen.getByText("Fichier binaire")).toBeTruthy();
    expect(document.querySelector(".cm-editor")).toBeNull();
    await open(store, "form.tsx");
    expect(screen.getByRole("tab", { name: "form.tsx, Nomi modifie ce fichier" })).toBeTruthy();
  });

  it("opens a 10 000-line file and typing does not write to the store on each keystroke", async () => {
    const big = Array.from({ length: 10_000 }, (_, index) => `const line${index} = ${index};`).join("\n");
    const { store } = await setup({ "big.ts": big });
    await open(store, "big.ts");
    expect(currentView().state.doc.lines).toBe(10_000);
    let updates = 0;
    const unsubscribe = store.subscribe(() => {
      updates += 1;
    });
    for (let index = 0; index < 50; index += 1) typeAtEnd("x");
    unsubscribe();
    // One store write: the dirty flag flipping; the buffer itself lives outside the store.
    expect(updates).toBe(1);
  });

  it("breadcrumbs reveal a folder in the tree", async () => {
    const { store } = await setup({ "src/lib/a.ts": "a" });
    await open(store, "src/lib/a.ts");
    const crumbs = screen.getByRole("navigation", { name: "Chemin du fichier" });
    fireEvent.click(within(crumbs).getByRole("button", { name: "lib" }));
    await flush();
    expect(store.getState().explorer.selected).toBe("src/lib");
    expect(within(crumbs).getByText("a.ts").getAttribute("aria-current")).toBe("page");
  });
});
