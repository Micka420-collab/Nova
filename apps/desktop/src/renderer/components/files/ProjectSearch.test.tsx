import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { createAtelierStore } from "../../state/editor-slice";
import { installDomPolyfills } from "../../test/dom";
import { AtelierProvider } from "../editor/atelier-context";
import { ProjectSearch } from "./ProjectSearch";
import { createSearchFake, fakeHash, SEARCH_WORKSPACE_ID } from "./search-test-client";

installDomPolyfills();
afterEach(cleanup);

const FILES = {
  "src/a.ts": "// TODO one\nconst a = 1;\n// todo two",
  "src/b.ts": "const b = 2; // TODO three",
  "src/c.ts": "nothing here",
};

async function setup(files: Record<string, string> = FILES) {
  const fake = createSearchFake(files);
  const store = createAtelierStore(fake.client);
  await act(() => store.getState().explorer.bind(SEARCH_WORKSPACE_ID));
  render(
    <AtelierProvider store={store} client={fake.client}>
      <ProjectSearch />
    </AtelierProvider>,
  );
  return { fake, store };
}

const search = (pattern: string) => {
  const input = screen.getByRole("textbox", { name: "Rechercher" });
  fireEvent.change(input, { target: { value: pattern } });
  fireEvent.submit(input.closest("form") as HTMLFormElement);
};

describe("ProjectSearch", () => {
  it("groups results by file with counts and highlighted matches", async () => {
    await setup();
    search("todo");
    expect(await screen.findByText("3 résultats dans 2 fichiers")).toBeTruthy();
    const groupA = screen.getByRole("button", { name: "src/a.ts, 2 résultats" });
    expect(groupA.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("button", { name: "src/b.ts, 1 résultat" })).toBeTruthy();
    const hits = document.querySelectorAll(".nv-search-hit");
    expect([...hits].map((hit) => hit.textContent)).toEqual(["TODO", "todo", "TODO"]);

    fireEvent.click(groupA);
    expect(groupA.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("button", { name: "Ligne 1 : // TODO one" })).toBeNull();
  });

  it("opens the file at the matched line and range", async () => {
    const { store } = await setup();
    search("todo");
    fireEvent.click(await screen.findByRole("button", { name: "Ligne 3 : // todo two" }));
    await waitFor(() => expect(store.getState().editor.activePath).toBe("src/a.ts"));
    expect(store.getState().editor.reveal).toMatchObject({ path: "src/a.ts", line: 3, from: 3, to: 7 });
  });

  it("passes case and whole-word options to the search", async () => {
    const { fake } = await setup();
    fireEvent.click(screen.getByRole("button", { name: "Respecter la casse" }));
    fireEvent.click(screen.getByRole("button", { name: "Mot entier" }));
    search("TODO");
    expect(await screen.findByText("2 résultats dans 2 fichiers")).toBeTruthy();
    expect(fake.textQueries.at(-1)).toMatchObject({ pattern: "TODO", caseSensitive: true, wholeWord: true, isRegex: false });
  });

  it("reports an invalid regular expression without calling the search", async () => {
    const { fake } = await setup();
    fireEvent.click(screen.getByRole("button", { name: "Expression régulière" }));
    search("(");
    expect((await screen.findByRole("alert")).textContent).toMatch(/^Expression régulière invalide : /);
    expect(fake.textQueries).toHaveLength(0);
  });

  it("says when nothing matches", async () => {
    await setup();
    search("absent");
    expect(await screen.findByText("Aucun résultat pour « absent »."))
      .toBeTruthy();
  });

  it("replaces after a preview, with the hash just read, skipping dirty buffers and reporting conflicts", async () => {
    const { fake, store } = await setup({
      ...FILES,
      "src/d.ts": "// TODO four",
    });
    // src/b.ts has unsaved edits in the editor: it must not be touched.
    await act(() => store.getState().editor.openFile("src/b.ts"));
    act(() => store.getState().editor.setDirty("src/b.ts", true));
    // src/d.ts changes on disk between the read and the write.
    fake.conflictOnWrite.add("src/d.ts");

    search("todo");
    await screen.findByText("4 résultats dans 3 fichiers");
    fireEvent.change(screen.getByRole("textbox", { name: "Remplacer" }), { target: { value: "DONE" } });
    fireEvent.click(screen.getByRole("button", { name: "Aperçu du remplacement" }));

    const preview = screen.getByRole("list", { name: "Aperçu du remplacement" });
    expect(within(preview).getByText("// DONE one")).toBeTruthy();
    expect(within(preview).getByText("non enregistré dans l'éditeur : ignoré")).toBeTruthy();
    expect((within(preview).getByRole("checkbox", { name: "Inclure src/b.ts" }) as HTMLInputElement).disabled).toBe(true);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Remplacer dans 2 fichiers" }));
    });
    expect(await screen.findByText("2 remplacements dans 1 fichier")).toBeTruthy();
    expect(screen.getByText("src/b.ts : non enregistré dans l'éditeur, ignoré.")).toBeTruthy();
    expect(screen.getByText("src/d.ts : modifié entre-temps, rien n'a été écrit.")).toBeTruthy();

    expect(fake.disk.get("src/a.ts")).toBe("// DONE one\nconst a = 1;\n// DONE two");
    expect(fake.disk.get("src/b.ts")).toBe(FILES["src/b.ts"]);
    expect(fake.disk.get("src/d.ts")).toBe("// TODO four");
    expect(fake.writes.map((write) => write.path).sort()).toEqual(["src/a.ts", "src/d.ts"]);
    expect(fake.writes.find((write) => write.path === "src/a.ts")?.expectedHash).toBe(fakeHash(FILES["src/a.ts"]));
  });

  it("can leave a file out of the replacement", async () => {
    const { fake } = await setup();
    search("todo");
    await screen.findByText("3 résultats dans 2 fichiers");
    fireEvent.change(screen.getByRole("textbox", { name: "Remplacer" }), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Aperçu du remplacement" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Inclure src/a.ts" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Remplacer dans 1 fichier" }));
    });
    expect(await screen.findByText("1 remplacement dans 1 fichier")).toBeTruthy();
    expect(fake.writes.map((write) => write.path)).toEqual(["src/b.ts"]);
  });
});
