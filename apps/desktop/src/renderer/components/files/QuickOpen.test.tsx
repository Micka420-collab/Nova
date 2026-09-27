import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { FileSearchResult } from "@nova/shared";
import { createAtelierStore } from "../../state/editor-slice";
import { installDomPolyfills } from "../../test/dom";
import { AtelierProvider } from "../editor/atelier-context";
import { QuickOpen } from "./QuickOpen";
import { createSearchFake, SEARCH_WORKSPACE_ID, type SearchFake } from "./search-test-client";

installDomPolyfills();
afterEach(cleanup);

async function setup(files: Record<string, string>, configure?: (fake: SearchFake) => void) {
  const fake = createSearchFake(files);
  configure?.(fake);
  const store = createAtelierStore(fake.client);
  await act(() => store.getState().explorer.bind(SEARCH_WORKSPACE_ID));
  let closed = 0;
  render(
    <AtelierProvider store={store} client={fake.client}>
      <QuickOpen open onClose={() => (closed += 1)} />
    </AtelierProvider>,
  );
  return { fake, store, closed: () => closed };
}

const input = () => screen.getByRole("combobox", { name: "Ouvrir un fichier" });
const optionNames = () => screen.queryAllByRole("option").map((option) => option.textContent);

describe("QuickOpen", () => {
  it("ranks basename matches first and opens the file at the requested line", async () => {
    const { store, closed } = await setup({
      "app/deep/other/index.ts": "x",
      "src/app.ts": "one\ntwo\nthree",
    });
    fireEvent.change(input(), { target: { value: "app:2" } });
    await waitFor(() => expect(optionNames()).toHaveLength(2));
    expect(optionNames()[0]).toContain("app.ts");
    expect(optionNames()[0]).toContain("ligne 2");

    fireEvent.keyDown(input(), { key: "Enter" });
    await waitFor(() => expect(store.getState().editor.activePath).toBe("src/app.ts"));
    expect(closed()).toBe(1);
    expect(store.getState().editor.reveal).toMatchObject({ path: "src/app.ts", line: 2 });
  });

  it("drops a response that arrives after a newer query", async () => {
    const pending: Record<string, (result: FileSearchResult) => void> = {};
    await setup({}, (fake) => {
      fake.filesAnswer = (query) => new Promise((resolve) => (pending[query] = resolve));
    });
    fireEvent.change(input(), { target: { value: "old" } });
    await waitFor(() => expect(pending.old).toBeDefined());
    fireEvent.change(input(), { target: { value: "new" } });
    await waitFor(() => expect(pending.new).toBeDefined());

    await act(async () => pending.new?.({ paths: ["src/new.ts"], truncated: false }));
    await waitFor(() => expect(optionNames()).toEqual(["new.tssrc"]));
    await act(async () => pending.old?.({ paths: ["src/old.ts"], truncated: false }));
    expect(optionNames()).toEqual(["new.tssrc"]);
  });

  it("says when results are partial and when nothing matches", async () => {
    const { fake } = await setup({});
    fake.filesAnswer = (query) =>
      Promise.resolve(query === "a" ? { paths: ["a.ts"], truncated: true } : { paths: [], truncated: false });
    fireEvent.change(input(), { target: { value: "a" } });
    expect(await screen.findByText("Résultats partiels : affine ta recherche.")).toBeTruthy();
    fireEvent.change(input(), { target: { value: "zz" } });
    expect(await screen.findByText("Aucun fichier ne correspond à « zz ».")).toBeTruthy();
  });

  it("lists recently opened files for an empty query", async () => {
    const { store } = await setup({ "src/a.ts": "a", "src/b.ts": "b" });
    await act(() => store.getState().editor.openFile("src/a.ts"));
    await act(() => store.getState().editor.openFile("src/b.ts"));
    await waitFor(() => expect(optionNames()).toEqual(["b.tssrc", "a.tssrc"]));
    expect(screen.getByText("Récents")).toBeTruthy();
  });
});
