import { describe, expect, it } from "vitest";
import { createNovaClient, NovaIpcError } from "@nova/shared";
import { createFakeBridge, makeConversation, makeMessage, VALID_CONNECTION } from "../test/fake-bridge";
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
