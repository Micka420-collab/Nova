import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { createNovaClient } from "@nova/shared";
import { Toaster } from "@nova/ui";
import { App } from "./App";
import { AppProvider } from "./state/context";
import { createAppStore } from "./state/store";
import {
  createFakeBridge,
  makeConversation,
  makeMessage,
  makeModel,
  VALID_CONNECTION,
  type FakeSeed,
} from "./test/fake-bridge";
import { installDomPolyfills } from "./test/dom";

installDomPolyfills();
afterEach(cleanup);

function renderApp(seed: FakeSeed) {
  const fake = createFakeBridge(seed);
  const client = createNovaClient(fake.bridge);
  const store = createAppStore(client);
  render(
    <AppProvider store={store} client={client}>
      <Toaster>
        <App />
      </Toaster>
    </AppProvider>,
  );
  return { ...fake, store };
}

describe("App", () => {
  it("without a key, shows the onboarding with the key form and the real vault options", async () => {
    renderApp({});
    expect(await screen.findByRole("heading", { name: "Connecte OpenRouter pour commencer" })).toBeTruthy();
    const key = screen.getByLabelText("Clé API OpenRouter") as HTMLInputElement;
    expect(key.type).toBe("password");
    expect(screen.getByRole("radio", { name: /Coffre du système \(recommandé\)/ })).toBeTruthy();
    expect(screen.getByText(/Ta clé reste sur cet appareil/)).toBeTruthy();
    // The companion says why it is not connected.
    expect(screen.getByText("Pas encore connecté")).toBeTruthy();
    // Landmarks of the workshop.
    expect(screen.getByRole("navigation", { name: "Navigation principale" })).toBeTruthy();
    expect(screen.getByRole("main")).toBeTruthy();
  });

  it("with a weak vault, recommends a session key and asks for an acknowledgment before weak storage", async () => {
    renderApp({ vaultLevel: "weak" });
    const session = (await screen.findByRole("radio", { name: /Cette session uniquement/ })) as HTMLInputElement;
    expect(session.checked).toBe(true);
    fireEvent.change(screen.getByLabelText("Clé API OpenRouter"), { target: { value: "sk-or-v1-test-key-1234" } });
    fireEvent.click(screen.getByRole("radio", { name: /protection faible/ }));
    const submit = screen.getByRole("button", { name: "Tester et enregistrer" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: /seulement masquée/ }));
    expect(submit.disabled).toBe(false);
  });

  it("with a key and a conversation, renders its messages, then live stream events", async () => {
    const model = makeModel({ id: "deepseek/deepseek-chat", name: "DeepSeek V3" });
    const conversation = makeConversation({ title: "Atelier du mardi", modelId: model.id });
    const user = makeMessage({ conversationId: conversation.id, role: "user", content: "Explique **le markdown**" });
    const answer = makeMessage({
      conversationId: conversation.id,
      content: "Voici **du gras** et du code :\n\n```ts\nconst a = 1;\n```",
      servedModel: "deepseek/deepseek-chat",
      servedProvider: "DeepInfra",
      usage: { promptTokens: 12, completionTokens: 34, reasoningTokens: null, cachedTokens: null, cost: null },
    });
    const { emit, calls, store } = renderApp({
      connection: VALID_CONNECTION,
      settings: { defaultModelId: model.id },
      conversations: [{ conversation, messages: [user, answer] }],
      models: [model],
    });

    const nav = await screen.findByRole("navigation", { name: "Navigation principale" });
    fireEvent.click(await within(nav).findByRole("button", { name: /^Atelier du mardi/ }));

    const messages = await screen.findByRole("region", { name: "Messages" });
    // User text is shown verbatim, answers as Markdown with a labelled code block.
    expect(within(messages).getByText("Explique **le markdown**")).toBeTruthy();
    expect(within(messages).getByText("du gras").tagName).toBe("STRONG");
    expect(within(messages).getByText("ts")).toBeTruthy();
    expect(within(messages).getByText("const a = 1;")).toBeTruthy();
    expect(within(messages).getByText(/coût inconnu · servi par deepseek\/deepseek-chat · via DeepInfra/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Modèle : DeepSeek V3" })).toBeTruthy();

    // A new message is sent, then its answer streams in through the event channel.
    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), { target: { value: "Et ensuite ?" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Envoyer" }));
    });
    expect(calls).toContain("chat.send");
    expect(within(messages).getByText("Et ensuite ?")).toBeTruthy();
    expect(within(messages).getByText("Nomi réfléchit…")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Arrêter" })).toBeTruthy();

    const stream = store.getState().streams[conversation.id];
    if (!stream) throw new Error("the send result did not start a stream");
    const ids = { streamId: stream.streamId, conversationId: conversation.id, messageId: stream.messageId };
    act(() => {
      emit({ type: "phase", ...ids, phase: "writing" });
      emit({ type: "delta", ...ids, text: "Ensuite, " });
      emit({ type: "delta", ...ids, text: "on teste." });
    });
    expect(within(messages).getByText("Ensuite, on teste.")).toBeTruthy();
    expect(screen.getByText("Nomi écrit…")).toBeTruthy();

    const final = makeMessage({
      id: stream.messageId,
      conversationId: conversation.id,
      content: "Ensuite, on teste.",
      servedModel: "deepseek/deepseek-chat",
      usage: { promptTokens: 20, completionTokens: 5, reasoningTokens: null, cachedTokens: null, cost: 0.0001 },
    });
    await act(async () => {
      emit({ type: "completed", streamId: stream.streamId, conversationId: conversation.id, message: final });
    });
    expect(screen.queryByRole("button", { name: "Arrêter" })).toBeNull();
    expect(screen.getByText("Réponse terminée", { selector: "output span" })).toBeTruthy();
    expect(within(messages).getByText(/0,0001 \$ constaté/)).toBeTruthy();
  });

  it("without a model, the composer is disabled and says why", async () => {
    const conversation = makeConversation({ title: "Sans modèle" });
    renderApp({ connection: VALID_CONNECTION, conversations: [{ conversation, messages: [] }] });
    const nav = await screen.findByRole("navigation", { name: "Navigation principale" });
    fireEvent.click(await within(nav).findByRole("button", { name: /^Sans modèle/ }));
    expect(await screen.findByText("Choisis un modèle pour envoyer ton message.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Envoyer" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
