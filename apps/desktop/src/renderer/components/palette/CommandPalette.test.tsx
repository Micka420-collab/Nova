import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { makeConversation, VALID_CONNECTION } from "../../test/fake-bridge";
import { installDomPolyfills } from "../../test/dom";
import { renderApp } from "../../test/render-app";

installDomPolyfills();
afterEach(cleanup);

async function openConversationSearch() {
  const conversation = makeConversation({ title: "Plan de voyage" });
  const app = renderApp({ connection: VALID_CONNECTION, conversations: [{ conversation, messages: [] }] });
  const nav = await screen.findByRole("navigation", { name: "Navigation principale" });
  await within(nav).findByRole("button", { name: /^Plan de voyage/ });
  fireEvent.keyDown(window, { key: "k", ctrlKey: true });
  const palette = screen.getByRole("dialog", { name: "Palette de commandes" });
  fireEvent.click(within(palette).getByRole("option", { name: "Rechercher une conversation" }));
  return { ...app, palette };
}

describe("CommandPalette conversation search", () => {
  it("announces its search in French while it runs, then lists matches", async () => {
    const { palette } = await openConversationSearch();
    expect(within(palette).getByRole("progressbar", { name: "Recherche…" })).toBeTruthy();
    expect(await within(palette).findByRole("option", { name: /Plan de voyage/ })).toBeTruthy();
  });

  it("says when nothing matches", async () => {
    const { palette } = await openConversationSearch();
    await within(palette).findByRole("option", { name: /Plan de voyage/ });
    fireEvent.change(within(palette).getByRole("combobox"), { target: { value: "introuvable" } });
    expect((await within(palette).findByRole("status")).textContent).toBe("Aucune conversation trouvée.");
  });

  it("says when the search failed", async () => {
    const { palette, failNext } = await openConversationSearch();
    await within(palette).findByRole("option", { name: /Plan de voyage/ });
    failNext("conversations.list", { code: "internal", message: "boom" });
    await act(async () => {
      fireEvent.change(within(palette).getByRole("combobox"), { target: { value: "plan" } });
    });
    expect((await within(palette).findByRole("alert")).textContent).toMatch(/Erreur interne de NOVA/);
  });
});
