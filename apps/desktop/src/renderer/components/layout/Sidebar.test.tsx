import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ProviderErrorInfo } from "@nova/shared";
import { makeConversation, makeMessage, makeModel, VALID_CONNECTION } from "../../test/fake-bridge";
import { installDomPolyfills } from "../../test/dom";
import { renderApp } from "../../test/render-app";

installDomPolyfills();
afterEach(cleanup);

const model = makeModel({ id: "vendor/model-a", name: "Modèle A" });
const flush = () => act(() => new Promise((resolve) => setTimeout(resolve)));

function failure(code: ProviderErrorInfo["code"]): ProviderErrorInfo {
  return { code, httpStatus: 401, retryAfterSec: null, providerMessage: null, retryable: false };
}

function twoConversations() {
  const first = makeConversation({ title: "Premier", modelId: model.id, updatedAt: 2_000 });
  const second = makeConversation({ title: "Second", modelId: model.id, updatedAt: 1_000 });
  return { first, second };
}

describe("Sidebar", () => {
  it("says when older conversations exist beyond the list", async () => {
    const { first } = twoConversations();
    renderApp({ connection: VALID_CONNECTION, conversations: [{ conversation: first, messages: [] }], hasMoreConversations: true });
    const nav = await screen.findByRole("navigation", { name: "Navigation principale" });
    expect(await within(nav).findByText("Des conversations plus anciennes existent : utilise la recherche.")).toBeTruthy();
  });

  it("after deleting a conversation from its row, gives focus to the next row", async () => {
    const { first, second } = twoConversations();
    renderApp({
      connection: VALID_CONNECTION,
      conversations: [
        { conversation: first, messages: [] },
        { conversation: second, messages: [] },
      ],
    });
    const nav = await screen.findByRole("navigation", { name: "Navigation principale" });
    const trash = await within(nav).findByRole("button", { name: "Supprimer « Premier »" });
    trash.focus();
    fireEvent.click(trash);
    const dialog = screen.getByRole("dialog", { name: "Supprimer « Premier » ?" });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Supprimer" }));
    });
    await flush();
    expect(within(nav).queryByRole("button", { name: /^Premier/ })).toBeNull();
    expect(document.activeElement).toBe(within(nav).getByRole("button", { name: /^Second/ }));
  });

  it("after deleting the only conversation, gives focus to the list heading", async () => {
    const { first } = twoConversations();
    renderApp({ connection: VALID_CONNECTION, conversations: [{ conversation: first, messages: [] }] });
    const nav = await screen.findByRole("navigation", { name: "Navigation principale" });
    const trash = await within(nav).findByRole("button", { name: "Supprimer « Premier »" });
    trash.focus();
    fireEvent.click(trash);
    await act(async () => {
      fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Supprimer" }));
    });
    await flush();
    expect(document.activeElement).toBe(within(nav).getByRole("heading", { name: "Conversations" }));
  });

  it("names a conversation that failed in the background and marks its row", async () => {
    const { first, second } = twoConversations();
    // As main stored it: the failed answer is the last one of the first conversation.
    const message = makeMessage({ conversationId: first.id, status: "error", error: failure("timeout") });
    const { emit } = renderApp({
      connection: VALID_CONNECTION,
      settings: { defaultModelId: model.id },
      conversations: [
        { conversation: first, messages: [message] },
        { conversation: second, messages: [] },
      ],
    });
    const nav = await screen.findByRole("navigation", { name: "Navigation principale" });
    fireEvent.click(await within(nav).findByRole("button", { name: /^Second/ }));
    await act(async () => {
      emit({ type: "failed", streamId: "s-1", conversationId: first.id, message, error: failure("timeout") });
    });
    await flush();
    expect(within(nav).getByText("« Premier » a échoué.")).toBeTruthy();
    expect(within(nav).queryByText("Le détail est affiché sous le message.")).toBeNull();
    // The marker is part of the row's name, so it is announced with the title.
    const row = within(nav).getByRole("button", { name: /^Dernière réponse en échec\s*Premier/ });
    expect(within(row).getByText("Dernière réponse en échec")).toBeTruthy();
    expect(within(within(nav).getByRole("button", { name: /^Second/ })).queryByText("Dernière réponse en échec")).toBeNull();
  });

  it("a key refused while chatting shows the recorded refused state in Nomi and the composer", async () => {
    const { first } = twoConversations();
    const { emit, setConnection, calls } = renderApp({
      connection: VALID_CONNECTION,
      settings: { defaultModelId: model.id },
      conversations: [{ conversation: first, messages: [] }],
      models: [model],
    });
    const nav = await screen.findByRole("navigation", { name: "Navigation principale" });
    fireEvent.click(await within(nav).findByRole("button", { name: /^Premier/ }));
    await screen.findByRole("textbox", { name: "Message" });
    const reads = calls.filter((name) => name === "connection.get").length;
    // Main records the refusal on the connection before it reports the failed answer.
    setConnection({ ...VALID_CONNECTION, state: "invalid", lastError: failure("invalid_key") });
    const message = makeMessage({ conversationId: first.id, status: "error", error: failure("invalid_key") });
    await act(async () => {
      emit({ type: "failed", streamId: "s-1", conversationId: first.id, message, error: failure("invalid_key") });
    });
    await flush();
    expect(calls.filter((name) => name === "connection.get").length).toBe(reads + 1);
    expect(within(nav).getByText("Clé refusée")).toBeTruthy();
    expect(screen.getByText("La clé OpenRouter est refusée : remplace-la pour envoyer un message.")).toBeTruthy();
  });
});
