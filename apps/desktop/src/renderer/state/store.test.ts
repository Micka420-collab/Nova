import { describe, expect, it } from "vitest";
import { createNovaClient, NovaIpcError, type Mission } from "@nova/shared";
import { createFakeBridge, makeConversation, makeMessage, VALID_CONNECTION } from "../test/fake-bridge";
import { makeWorkspace } from "../test/atelier-fake";
import { createAppStore } from "./store";

const MODEL = "vendor/model-a";

async function storeWithStream() {
  const conversation = makeConversation({ modelId: MODEL });
  const fake = createFakeBridge({
    connection: VALID_CONNECTION,
    settings: { defaultModelId: MODEL },
    conversations: [{ conversation, messages: [] }],
  });
  const store = createAppStore(createNovaClient(fake.bridge));
  store.getState().start();
  await store.getState().loadCore();
  await store.getState().send("Bonjour", conversation.id);
  const stream = store.getState().streams[conversation.id];
  if (!stream) throw new Error("no stream started");
  return { ...fake, store, conversation, stream };
}

describe("store", () => {
  it("refuses to close or switch the folder while one of its missions runs, and leaves it on screen", async () => {
    const fake = createFakeBridge({ connection: VALID_CONNECTION });
    const store = createAppStore(createNovaClient(fake.bridge));
    const workspace = makeWorkspace();
    const running: Mission = {
      id: "00000000-0000-4000-8000-00000000a001",
      workspaceId: workspace.id,
      conversationId: null,
      title: "Corriger le panier",
      goal: "g",
      mode: "fix",
      state: "running",
      modelId: null,
      createdAt: 1,
      startedAt: 1,
      endedAt: null,
      updatedAt: 1,
    };
    store.setState((state) => ({
      workspace: { ...state.workspace, current: workspace, status: "ready" },
      missions: { ...state.missions, list: [running], listStatus: "ready" },
    }));
    await expect(store.getState().closeWorkspace()).rejects.toMatchObject({ code: "conflict" });
    await expect(store.getState().openWorkspace()).rejects.toMatchObject({ code: "conflict" });
    await expect(store.getState().reopenWorkspace(workspace.id)).rejects.toMatchObject({ code: "conflict" });
    expect(fake.calls.filter((call) => call.startsWith("workspace."))).toEqual([]);
    expect(store.getState().missions.list).toEqual([running]);
  });

  it("puts a terminal explanation in the chat draft and shows that chat, even with a mission selected", () => {
    const store = createAppStore(createNovaClient(createFakeBridge({ connection: VALID_CONNECTION }).bridge));
    store.setState((state) => ({
      workMode: "fix",
      missions: { ...state.missions, selectedId: "mission-1" },
      ui: { ...state.ui, route: "home", agentOpen: false },
    }));
    store.getState().setDraft(null, "Avant");
    store.getState().draftIntoChat("Explique cette erreur");
    const state = store.getState();
    expect(state.drafts["new"]?.text).toBe("Avant\n\nExplique cette erreur");
    expect(state.workMode).toBe("discuss");
    expect(state.missions.selectedId).toBeNull();
    expect(state.ui).toMatchObject({ route: "chat", agentOpen: true });
  });

  it("opens the narrow layout's overlay for every document or terminal request, and only there", () => {
    const store = createAppStore(createNovaClient(createFakeBridge({ connection: VALID_CONNECTION }).bridge));
    store.getState().openDoc({ kind: "diff", missionId: "m1" });
    expect(store.getState().ui.contextOverlayOpen).toBe(false);
    store.getState().setUi({ narrow: true });
    store.getState().openDoc({ kind: "diff", missionId: "m1" });
    expect(store.getState().ui.contextOverlayOpen).toBe(true);
    store.getState().setUi({ contextOverlayOpen: false });
    store.getState().revealFile("src/a.ts", 3);
    expect(store.getState().ui.contextOverlayOpen).toBe(true);
    store.getState().setUi({ contextOverlayOpen: false });
    store.getState().revealTerminal("session-1");
    expect(store.getState().ui).toMatchObject({ contextOverlayOpen: true, dockOpen: true, dockTab: "terminal" });
  });

  it("stop() treats a stream main no longer knows as already ended, and reports other failures", async () => {
    const { store, failNext, conversation } = await storeWithStream();
    failNext("chat.stop", { code: "not_found", message: "Active stream not found" });
    await expect(store.getState().stop(conversation.id)).resolves.toBeUndefined();
    failNext("chat.stop", { code: "internal", message: "boom" });
    await expect(store.getState().stop(conversation.id)).rejects.toBeInstanceOf(NovaIpcError);
  });

  it("marks a conversation failed from main's stored last answer and clears it when a new run starts", async () => {
    const { store, emit, conversation, stream } = await storeWithStream();
    const error = { code: "timeout", httpStatus: null, retryAfterSec: null, providerMessage: null, retryable: true } as const;
    const message = makeMessage({ id: stream.messageId, conversationId: conversation.id, status: "error", error });
    emit({ type: "failed", streamId: stream.streamId, conversationId: conversation.id, message, error });
    // Read back from main, which stored the failed answer as the last one.
    await new Promise((resolve) => setTimeout(resolve));
    expect(store.getState().failed[conversation.id]).toBe(true);
    emit({ type: "phase", streamId: "next", conversationId: conversation.id, messageId: "m-next", phase: "waiting" });
    expect(store.getState().failed[conversation.id]).toBeUndefined();
  });

  it("keeps a failed send's text and error in one draft, and drops both once a send succeeds", async () => {
    const { store, failNext, conversation } = await storeWithStream();
    store.getState().setDraft(conversation.id, "Texte");
    failNext("chat.send", { code: "conflict", message: "busy" });
    expect(await store.getState().sendDraft("Texte", conversation.id)).toBe(false);
    expect(store.getState().drafts[conversation.id]).toEqual({ text: "Texte", error: { code: "conflict", providerError: null } });
    expect(await store.getState().sendDraft("Texte", conversation.id)).toBe(true);
    expect(store.getState().drafts[conversation.id]).toBeUndefined();
  });
});
