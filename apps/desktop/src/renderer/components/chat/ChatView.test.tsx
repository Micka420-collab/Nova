import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message, ProviderErrorInfo } from "@nova/shared";
import { makeConversation, makeMessage, makeModel, VALID_CONNECTION, type FakeSeed } from "../../test/fake-bridge";
import { installDomPolyfills } from "../../test/dom";
import { renderApp } from "../../test/render-app";

installDomPolyfills();
afterEach(cleanup);

const model = makeModel({ id: "vendor/model-a", name: "Modèle A" });

function providerError(code: ProviderErrorInfo["code"], providerMessage: string | null = null): ProviderErrorInfo {
  return { code, httpStatus: 503, retryAfterSec: null, providerMessage, retryable: true };
}

/** One conversation whose last answer is `answer`, opened in the chat view. */
async function openWithAnswer(answer: Partial<Message>, seed: Partial<FakeSeed> = {}) {
  const conversation = makeConversation({ title: "Atelier", modelId: model.id });
  const user = makeMessage({ conversationId: conversation.id, role: "user", content: "Question" });
  const last = makeMessage({ conversationId: conversation.id, modelId: model.id, ...answer });
  const app = renderApp({
    connection: VALID_CONNECTION,
    settings: { defaultModelId: model.id },
    conversations: [{ conversation, messages: [user, last] }],
    models: [model],
    ...seed,
  });
  const nav = await screen.findByRole("navigation", { name: "Navigation principale" });
  fireEvent.click(await within(nav).findByRole("button", { name: /^Atelier/ }));
  const messages = await screen.findByRole("region", { name: "Messages" });
  return { ...app, conversation, messages };
}

describe("refused links in answers", () => {
  const writeText = vi.fn<(text: string) => Promise<void>>(async () => undefined);
  beforeEach(() => {
    writeText.mockClear();
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  });

  it("shows the real destination and copies it only on an explicit action", async () => {
    const { messages, failNext } = await openWithAnswer({
      content: "Va sur [https://openrouter.ai/keys](https://evil.example/login?next=1).",
    });
    failNext("app.openExternal", { code: "invalid_request", message: "URL not allowed" });
    await act(async () => {
      fireEvent.click(within(messages).getByRole("link", { name: "https://openrouter.ai/keys" }));
    });
    const callout = within(messages).getByText("NOVA n'ouvre pas ce lien").closest(".nv-callout") as HTMLElement;
    expect(within(callout).getByText("https://evil.example")).toBeTruthy();
    expect(within(callout).getByText("https://evil.example/login?next=1")).toBeTruthy();
    // Nothing reached the clipboard behind the user's back.
    expect(writeText).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(within(callout).getByRole("button", { name: "Copier l'adresse" }));
    });
    expect(writeText).toHaveBeenCalledExactlyOnceWith("https://evil.example/login?next=1");
    expect(within(callout).getByRole("button", { name: "Adresse copiée" })).toBeTruthy();
  });

  it("scrolls to in-answer anchors (footnotes) without asking main to open them", async () => {
    const scroll = vi.spyOn(Element.prototype, "scrollIntoView");
    const { messages, calls } = await openWithAnswer({ content: "Une note[^1].\n\n[^1]: Le détail." });
    const reference = within(messages).getByRole("link", { name: "1" });
    expect(reference.getAttribute("href")).toMatch(/^#/);
    await act(async () => {
      fireEvent.click(reference);
    });
    expect(calls).not.toContain("app.openExternal");
    expect(scroll).toHaveBeenCalled();
    expect((scroll.mock.contexts.at(-1) as HTMLElement).id).toBe("user-content-fn-1");
    expect(within(messages).queryByText("NOVA n'ouvre pas ce lien")).toBeNull();
    scroll.mockRestore();
  });
});

describe("retrying an answer", () => {
  it.each([
    ["a failed answer", { status: "error" as const, error: providerError("network") }, "Réessayer"],
    ["a stopped answer", { status: "stopped" as const, content: "Début" }, "Relancer"],
  ])("sends one retry for a double click on %s", async (_case, answer, label) => {
    const { messages, calls } = await openWithAnswer(answer);
    const button = within(messages).getByRole("button", { name: label });
    // Two discrete clicks: React commits the first one's state before the second arrives.
    fireEvent.click(button);
    fireEvent.click(button);
    await act(async () => undefined);
    expect(calls.filter((name) => name === "chat.retry")).toHaveLength(1);
  });
});

describe("a retry that ends before any text", () => {
  it.each(["stopped", "failed"] as const)("%s: shows the previous answer main restored, not the deleted one", async (type) => {
    const { messages, store, emit, conversation } = await openWithAnswer({ status: "stopped", content: "Ancienne réponse" });
    fireEvent.click(within(messages).getByRole("button", { name: "Relancer" }));
    await act(async () => undefined);
    const stream = store.getState().streams[conversation.id];
    if (!stream) throw new Error("the retry did not start a stream");
    expect(within(messages).queryByText("Ancienne réponse")).toBeNull();
    const error = providerError("network");
    const ended = makeMessage({
      id: stream.messageId,
      conversationId: conversation.id,
      status: type === "failed" ? "error" : "stopped",
      error: type === "failed" ? error : null,
    });
    await act(async () => {
      if (type === "failed") emit({ type, streamId: stream.streamId, conversationId: conversation.id, message: ended, error });
      else emit({ type, streamId: stream.streamId, conversationId: conversation.id, message: ended });
    });
    await act(() => new Promise((resolve) => setTimeout(resolve)));
    expect(within(messages).getByText("Ancienne réponse")).toBeTruthy();
    expect(store.getState().detail?.messages.some((message) => message.id === stream.messageId)).toBe(false);
  });
});

describe("no provider available (HTTP 503)", () => {
  it("reads as an outage with a model change, without blaming privacy when retention is allowed", async () => {
    const { messages } = await openWithAnswer(
      { status: "error", error: providerError("no_provider", "No available model provider") },
      { settings: { defaultModelId: model.id, privacy: { providerDataCollection: "allow" } } },
    );
    expect(within(messages).getByText(/ne peut servir ce modèle pour l'instant/)).toBeTruthy();
    expect(within(messages).getByRole("button", { name: "Changer de modèle" })).toBeTruthy();
    expect(within(messages).getByRole("button", { name: "Réessayer" })).toBeTruthy();
    expect(within(messages).queryByRole("button", { name: "Ouvrir la confidentialité" })).toBeNull();
    expect(within(messages).queryByText(/politique de conservation/)).toBeNull();
  });

  it("adds the data policy as a secondary hint when retention is refused or the provider names it", async () => {
    const { messages } = await openWithAnswer(
      { status: "error", error: providerError("no_provider") },
      { settings: { defaultModelId: model.id, privacy: { providerDataCollection: "deny" } } },
    );
    expect(within(messages).getByText(/politique de conservation des données écarte aussi/)).toBeTruthy();
    expect(within(messages).getByRole("button", { name: "Changer de modèle" })).toBeTruthy();
    expect(within(messages).getByRole("button", { name: "Ouvrir la confidentialité" })).toBeTruthy();
  });
});

describe("new provider outcomes", () => {
  it.each([
    ["truncated", /longueur maximale/, "Réessayer"],
    ["filtered", /filtre du fournisseur/, "Changer de modèle"],
    ["empty_response", /n'a rien répondu/, "Réessayer"],
  ] as const)("%s has French copy and its follow-up", async (code, title, action) => {
    const { messages } = await openWithAnswer({ status: "error", content: "Partiel", error: providerError(code) });
    expect(within(messages).getByText(title)).toBeTruthy();
    expect(within(messages).getAllByRole("button", { name: action }).length).toBeGreaterThan(0);
  });
});

describe("composer drafts", () => {
  it("keeps a failed message's text with its error across conversation switches", async () => {
    const first = makeConversation({ title: "Premier", modelId: model.id, updatedAt: 2_000 });
    const second = makeConversation({ title: "Second", modelId: model.id, updatedAt: 1_000 });
    const { failNext } = renderApp({
      connection: VALID_CONNECTION,
      settings: { defaultModelId: model.id },
      conversations: [
        { conversation: first, messages: [] },
        { conversation: second, messages: [] },
      ],
      models: [model],
    });
    const nav = await screen.findByRole("navigation", { name: "Navigation principale" });
    fireEvent.click(await within(nav).findByRole("button", { name: /^Premier/ }));
    fireEvent.change(await screen.findByRole("textbox", { name: "Message" }), { target: { value: "Texte important" } });
    failNext("chat.send", { code: "conflict", message: "busy" });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Envoyer" }));
    });
    expect(screen.getByText("Le message n'est pas parti")).toBeTruthy();

    fireEvent.click(within(nav).getByRole("button", { name: /^Second/ }));
    expect((await screen.findByRole("textbox", { name: "Message" }) as HTMLTextAreaElement).value).toBe("");
    expect(screen.queryByText("Le message n'est pas parti")).toBeNull();

    fireEvent.click(within(nav).getByRole("button", { name: /^Premier/ }));
    expect((screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement).value).toBe("Texte important");
    expect(screen.getByText("Le message n'est pas parti")).toBeTruthy();
  });

  it("offers to enter the key again when the stored key cannot be read", async () => {
    const { failNext, store } = await openWithAnswer({ content: "Réponse" });
    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), { target: { value: "Suite" } });
    failNext("chat.send", { code: "key_unreadable", message: "keyring locked" });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Envoyer" }));
    });
    expect(screen.getByText(/trousseau du système est verrouillé/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Saisir la clé à nouveau" }));
    expect(store.getState().ui.route).toBe("settings");
    expect(store.getState().ui.settingsSection).toBe("providers");
  });
});

describe("stopping a generation that just ended", () => {
  it("shows no error when main no longer knows the stream", async () => {
    const { store, failNext, conversation } = await openWithAnswer({ content: "Réponse" });
    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), { target: { value: "Encore" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Envoyer" }));
    });
    expect(store.getState().streams[conversation.id]).toBeTruthy();
    failNext("chat.stop", { code: "not_found", message: "Active stream not found" });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Arrêter" }));
    });
    expect(screen.queryByText(/Élément introuvable/)).toBeNull();
  });
});
