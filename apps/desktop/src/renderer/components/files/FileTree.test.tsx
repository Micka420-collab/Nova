import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { GitStatus } from "@nova/shared";
import { createAtelierStore } from "../../state/editor-slice";
import { installDomPolyfills } from "../../test/dom";
import { AtelierProvider } from "../editor/atelier-context";
import { FileTree } from "./FileTree";
import { createFakeAtelierClient, WORKSPACE_ID, type FakeAtelierOptions } from "./test-client";

installDomPolyfills();
afterEach(cleanup);

const flush = () => act(() => new Promise((resolve) => setTimeout(resolve)));

const FILES = {
  "src/app.ts": "export const app = 1;\n",
  "src/api.ts": "export {};\n",
  "src/lib/util.ts": "export {};\n",
  "package.json": "{}\n",
  "README.md": "# Mon site\n",
  "dist/bundle.js": "",
};

async function setup(options: FakeAtelierOptions = {}, agentTouchedPaths?: ReadonlySet<string>) {
  const fake = createFakeAtelierClient(FILES, options);
  const store = createAtelierStore(fake.client);
  render(
    <AtelierProvider store={store} client={fake.client}>
      <FileTree agentTouchedPaths={agentTouchedPaths} />
    </AtelierProvider>,
  );
  await act(() => store.getState().explorer.bind(WORKSPACE_ID));
  await flush();
  const tree = screen.getByRole("tree", { name: "Fichiers du projet" });
  return { fake, store, tree };
}

const item = (tree: HTMLElement, name: string | RegExp) => within(tree).getByRole("treeitem", { name });
const press = (key: string, init: Partial<KeyboardEventInit> = {}) =>
  act(() => {
    fireEvent.keyDown(document.activeElement ?? document.body, { key, ...init });
  });

describe("FileTree", () => {
  it("says so when no workspace is bound", () => {
    const fake = createFakeAtelierClient(FILES);
    render(
      <AtelierProvider store={createAtelierStore(fake.client)} client={fake.client}>
        <FileTree />
      </AtelierProvider>,
    );
    expect(screen.getByText("Aucun dossier ouvert")).toBeTruthy();
  });

  it("lists the root, then a directory only when it is expanded", async () => {
    const { fake, tree } = await setup();
    expect(within(tree).getAllByRole("treeitem").map((row) => row.getAttribute("aria-label"))).toEqual([
      "dist",
      "src",
      "package.json",
      "README.md",
    ]);
    expect(fake.callsOf("files.list")).toEqual([{ workspaceId: WORKSPACE_ID, path: "" }]);
    const src = item(tree, "src");
    expect(src.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(src);
    await flush();
    expect(src.getAttribute("aria-expanded")).toBe("true");
    expect(item(tree, "app.ts").getAttribute("aria-level")).toBe("2");
    expect(fake.callsOf("files.list")).toContainEqual({ workspaceId: WORKSPACE_ID, path: "src" });
  });

  it("moves focus with the keyboard like a tree (arrows, Home, End, typeahead)", async () => {
    const { tree } = await setup();
    const src = item(tree, "src");
    // One tab stop: the first row until the user moves.
    expect(item(tree, "dist").tabIndex).toBe(0);
    expect(src.tabIndex).toBe(-1);
    act(() => src.focus());
    await press("ArrowRight");
    await flush();
    expect(src.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(src);
    await press("ArrowRight");
    expect(document.activeElement).toBe(item(tree, "lib"));
    await press("ArrowDown");
    expect(document.activeElement).toBe(item(tree, "api.ts"));
    await press("ArrowLeft");
    expect(document.activeElement).toBe(src);
    await press("End");
    expect(document.activeElement).toBe(item(tree, "README.md"));
    expect(document.activeElement?.getAttribute("tabindex")).toBe("0");
    expect(src.tabIndex).toBe(-1);
    await press("Home");
    expect(document.activeElement).toBe(item(tree, "dist"));
    await press("p");
    expect(document.activeElement).toBe(item(tree, "package.json"));
  });

  it("opens a file with Enter in the editor and selects its row", async () => {
    const { store, tree } = await setup();
    const readme = item(tree, "README.md");
    act(() => readme.focus());
    await press("Enter");
    await flush();
    expect(store.getState().editor.activePath).toBe("README.md");
    expect(readme.getAttribute("aria-selected")).toBe("true");
  });

  it("shows Git letters, ignored entries, outside links and Nomi dots with accessible text", async () => {
    const git: GitStatus = {
      available: true,
      branch: "main",
      upstream: null,
      ahead: null,
      behind: null,
      truncated: false,
      entries: [
        { path: "package.json", origPath: null, index: "unmodified", worktree: "modified" },
        { path: "README.md", origPath: null, index: "unmodified", worktree: "untracked" },
      ],
    };
    const { store, tree } = await setup(
      { git, ignored: ["dist"], outside: ["linked"] },
      new Set(["README.md"]),
    );
    expect(item(tree, "package.json, modifié").textContent).toContain("M");
    expect(item(tree, "README.md, non suivi par Git, touché par Nomi")).toBeTruthy();
    expect(item(tree, "dist, ignoré").className).toContain("nova-tree__row--ignored");
    const linked = item(tree, "linked");
    expect(linked.getAttribute("aria-disabled")).toBe("true");
    expect(linked.getAttribute("title")).toBe("Hors du projet : non suivi.");
    fireEvent.click(linked);
    await flush();
    expect(store.getState().editor.activePath).toBeNull();
  });

  it("offers a retry when a directory cannot be read", async () => {
    const { fake, tree } = await setup({ failures: { "files.list:src": "internal" } });
    fireEvent.click(item(tree, "src"));
    await flush();
    const error = item(tree, "Dossier illisible");
    fake.fail("files.list:src", null);
    fireEvent.click(within(error).getByRole("button", { name: "Réessayer" }));
    await flush();
    expect(item(tree, "app.ts")).toBeTruthy();
  });

  it("renames with F2: moves the file and makes open tabs follow", async () => {
    const { fake, store, tree } = await setup();
    await act(() => store.getState().editor.openFile("README.md"));
    const readme = item(tree, "README.md");
    act(() => readme.focus());
    await press("F2");
    const input = screen.getByRole("textbox", { name: "Nouveau nom de « README.md »" });
    fireEvent.change(input, { target: { value: "a/b" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect((await screen.findByRole("alert")).textContent).toContain("Nom invalide");
    fireEvent.change(input, { target: { value: "LISEZMOI.md" } });
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });
    await flush();
    expect(fake.callsOf("files.move")).toEqual([{ workspaceId: WORKSPACE_ID, from: "README.md", to: "LISEZMOI.md" }]);
    expect(store.getState().editor.tabs.map((tab) => tab.path)).toEqual(["LISEZMOI.md"]);
    expect(document.activeElement).toBe(item(tree, "LISEZMOI.md"));
  });

  it("asks before moving to the trash, then trashes", async () => {
    const { fake, tree } = await setup();
    act(() => item(tree, "package.json").focus());
    await press("Delete");
    const dialog = screen.getByRole("dialog", { name: "Mettre « package.json » à la corbeille ?" });
    expect(fake.callsOf("files.trash")).toEqual([]);
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Mettre à la corbeille" }));
    });
    await flush();
    expect(fake.callsOf("files.trash")).toEqual([{ workspaceId: WORKSPACE_ID, path: "package.json" }]);
    expect(within(tree).queryByRole("treeitem", { name: "package.json" })).toBeNull();
  });

  it("opens the context menu from the keyboard and closes it with Escape, back on the row", async () => {
    const { tree } = await setup();
    const src = item(tree, "src");
    act(() => src.focus());
    await press("F10", { shiftKey: true });
    const menu = screen.getByRole("menu", { name: "Actions pour « src »" });
    const items = within(menu).getAllByRole("menuitem");
    expect(items.map((node) => node.textContent)).toEqual([
      "Nouveau fichier",
      "Nouveau dossier",
      "Renommer",
      "Mettre à la corbeille",
      "Copier le chemin",
    ]);
    expect(document.activeElement).toBe(items[0]);
    await press("ArrowDown");
    expect(document.activeElement).toBe(items[1]);
    await press("Escape");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(src);
  });

  it("creates a file from the context menu inside the directory and opens it", async () => {
    const { fake, store, tree } = await setup();
    act(() => item(tree, "src").focus());
    await press("ContextMenu");
    fireEvent.click(screen.getByRole("menuitem", { name: "Nouveau fichier" }));
    await flush();
    const input = screen.getByRole("textbox", { name: "Nom du nouveau fichier" });
    fireEvent.change(input, { target: { value: "form.tsx" } });
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });
    await flush();
    expect(fake.callsOf("files.create")).toEqual([{ workspaceId: WORKSPACE_ID, path: "src/form.tsx", kind: "file" }]);
    expect(item(tree, "form.tsx")).toBeTruthy();
    expect(store.getState().editor.activePath).toBe("src/form.tsx");
  });
});
