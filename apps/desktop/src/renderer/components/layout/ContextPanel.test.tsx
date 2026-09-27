import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { makeConversation, makeMessage, makeModel, VALID_CONNECTION } from "../../test/fake-bridge";
import { installDomPolyfills } from "../../test/dom";
import { renderApp } from "../../test/render-app";

installDomPolyfills();
afterEach(cleanup);

describe("ContextPanel", () => {
  it("shows the model requested for the answer served, and a pending choice apart", async () => {
    const used = makeModel({ id: "vendor/used", name: "Modèle utilisé" });
    const next = makeModel({ id: "vendor/next", name: "Modèle suivant" });
    const conversation = makeConversation({ title: "Atelier", modelId: used.id });
    const answer = makeMessage({
      conversationId: conversation.id,
      content: "Réponse",
      modelId: used.id,
      servedModel: "vendor/used-2025",
      servedProvider: "Fournisseur X",
    });
    const { store } = renderApp({
      connection: VALID_CONNECTION,
      conversations: [{ conversation, messages: [answer] }],
      models: [used, next],
    });
    const nav = await screen.findByRole("navigation", { name: "Navigation principale" });
    fireEvent.click(await within(nav).findByRole("button", { name: /^Atelier/ }));
    await screen.findByRole("region", { name: "Messages" });
    await act(async () => {
      await store.getState().chooseModel(next.id, "conversation");
    });
    const panel = screen.getByRole("tabpanel", { name: "Contexte" });
    const requested = within(panel).getByText("Modèle demandé").nextElementSibling as HTMLElement;
    expect(requested.textContent).toContain("Modèle utilisé");
    expect(requested.textContent).not.toMatch(/^Modèle suivant/);
    expect(within(requested).getByText("Prochain message : Modèle suivant")).toBeTruthy();
    expect((within(panel).getByText("Modèle servi").nextElementSibling as HTMLElement).textContent).toBe("vendor/used-2025");
  });

  it("shows no pending line when the next message uses the requested model", async () => {
    const used = makeModel({ id: "vendor/used", name: "Modèle utilisé" });
    const conversation = makeConversation({ title: "Atelier", modelId: used.id });
    const answer = makeMessage({ conversationId: conversation.id, content: "Réponse", modelId: used.id });
    renderApp({ connection: VALID_CONNECTION, conversations: [{ conversation, messages: [answer] }], models: [used] });
    const nav = await screen.findByRole("navigation", { name: "Navigation principale" });
    fireEvent.click(await within(nav).findByRole("button", { name: /^Atelier/ }));
    await screen.findByRole("region", { name: "Messages" });
    const panel = screen.getByRole("tabpanel", { name: "Contexte" });
    expect(within(panel).queryByText(/Prochain message/)).toBeNull();
  });
});
