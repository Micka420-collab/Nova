import { describe, expect, it } from "vitest";
import type { ConversationDetail, ConversationSummary, Message, ProviderErrorInfo } from "@nova/shared";
import { makeConversation, makeMessage, testId } from "../test/fake-bridge";
import {
  applyChatEvent,
  applyLoadedDetail,
  applyRetryResult,
  applySendResult,
  type ChatSlice,
  type StreamView,
} from "./chat-reducer";

const ZERO_USAGE = { promptTokens: 0, completionTokens: 0, cost: 0, messagesWithUnknownCost: 0 };

function summary(conversation: ReturnType<typeof makeConversation>, preview: string | null): ConversationSummary {
  return { ...conversation, messageCount: 2, preview };
}

function setup() {
  const active = makeConversation({ title: "Active", updatedAt: 2_000 });
  const other = makeConversation({ title: "Other", updatedAt: 1_000 });
  const user = makeMessage({ conversationId: active.id, role: "user", content: "Salut" });
  const answer = makeMessage({ conversationId: active.id, status: "streaming", content: "" });
  const stream: StreamView = { streamId: testId(), messageId: answer.id, phase: "waiting", draft: "", fromStart: true };
  const detail: ConversationDetail = { conversation: active, messages: [user, answer], usage: ZERO_USAGE };
  const state: ChatSlice = {
    streams: { [active.id]: stream },
    detail,
    conversations: [summary(active, "Salut"), summary(other, "Ancien")],
  };
  return { active, other, answer, stream, state };
}

function messageById(state: ChatSlice, id: string): Message | undefined {
  return state.detail?.messages.find((message) => message.id === id);
}

describe("applyChatEvent", () => {
  it("appends deltas to the stream draft and to the shown message, in order", () => {
    const { active, answer, stream, state } = setup();
    const ids = { streamId: stream.streamId, conversationId: active.id, messageId: answer.id };
    let next = applyChatEvent(state, { type: "delta", ...ids, text: "Bon" });
    next = applyChatEvent(next, { type: "delta", ...ids, text: "jour" });
    expect(next.streams[active.id]).toMatchObject({ draft: "Bonjour", phase: "writing" });
    expect(messageById(next, answer.id)?.content).toBe("Bonjour");
    // The input state is left untouched (pure reducer).
    expect(messageById(state, answer.id)?.content).toBe("");
  });

  it("tracks the phase and the served model reported by the provider", () => {
    const { active, answer, stream, state } = setup();
    const ids = { streamId: stream.streamId, conversationId: active.id, messageId: answer.id };
    let next = applyChatEvent(state, { type: "phase", ...ids, phase: "reasoning" });
    next = applyChatEvent(next, { type: "meta", ...ids, servedModel: "deepseek/deepseek-chat", servedProvider: "DeepInfra" });
    expect(next.streams[active.id]?.phase).toBe("reasoning");
    expect(messageById(next, answer.id)).toMatchObject({ servedModel: "deepseek/deepseek-chat", servedProvider: "DeepInfra" });
  });

  it.each(["completed", "stopped"] as const)("%s replaces the message with main's version and ends the stream", (type) => {
    const { active, answer, stream, state } = setup();
    const final = { ...answer, content: "Réponse finale", status: type === "completed" ? "complete" : "stopped", updatedAt: 3_000 } as const;
    const next = applyChatEvent(state, { type, streamId: stream.streamId, conversationId: active.id, message: final });
    expect(messageById(next, answer.id)).toEqual(final);
    expect(next.streams[active.id]).toBeUndefined();
    expect(next.conversations[0]).toMatchObject({ id: active.id, preview: "Réponse finale", updatedAt: 3_000 });
  });

  it("failed stores the error on the message and ends the stream", () => {
    const { active, answer, stream, state } = setup();
    const error: ProviderErrorInfo = {
      code: "rate_limited",
      httpStatus: 429,
      retryAfterSec: 7,
      providerMessage: null,
      retryable: true,
    };
    const final: Message = { ...answer, status: "error", error };
    const next = applyChatEvent(state, {
      type: "failed",
      streamId: stream.streamId,
      conversationId: active.id,
      message: final,
      error,
    });
    expect(messageById(next, answer.id)?.error?.code).toBe("rate_limited");
    expect(next.streams[active.id]).toBeUndefined();
  });

  it("events of another conversation update its stream and list entry, never the shown detail", () => {
    const { other, state } = setup();
    const streamId = testId();
    const messageId = testId();
    let next = applyChatEvent(state, { type: "phase", streamId, conversationId: other.id, messageId, phase: "waiting" });
    next = applyChatEvent(next, { type: "delta", streamId, conversationId: other.id, messageId, text: "Texte" });
    expect(next.detail).toBe(state.detail);
    expect(next.streams[other.id]).toMatchObject({ draft: "Texte", fromStart: true });

    const final = makeMessage({ id: messageId, conversationId: other.id, content: "Texte complet", updatedAt: 5_000 });
    next = applyChatEvent(next, { type: "completed", streamId, conversationId: other.id, message: final });
    expect(next.detail).toBe(state.detail);
    expect(next.streams[other.id]).toBeUndefined();
    // Most recently updated first, with the new preview.
    expect(next.conversations.map((item) => item.id)).toEqual([other.id, state.conversations[0]?.id]);
    expect(next.conversations[0]?.preview).toBe("Texte complet");
  });

  it("a terminal event of an older stream does not end the current one", () => {
    const { active, answer, stream, state } = setup();
    const stale = applyChatEvent(state, {
      type: "stopped",
      streamId: testId(),
      conversationId: active.id,
      message: { ...answer, status: "stopped" },
    });
    expect(stale.streams[active.id]).toEqual(stream);
  });
});

describe("send, retry and load results", () => {
  it("a send creating a conversation shows it, keeps text streamed before the result and lists it first", () => {
    const empty: ChatSlice = { streams: {}, detail: null, conversations: [] };
    const conversation = makeConversation({ updatedAt: 9_000 });
    const userMessage = makeMessage({ conversationId: conversation.id, role: "user", content: "Une idée" });
    const assistantMessage = makeMessage({ conversationId: conversation.id, status: "streaming" });
    const streamId = testId();
    const early = applyChatEvent(empty, {
      type: "delta",
      streamId,
      conversationId: conversation.id,
      messageId: assistantMessage.id,
      text: "Dé",
    });
    const next = applySendResult(early, { conversation, userMessage, assistantMessage, streamId }, true);
    expect(next.detail?.messages.map((message) => message.content)).toEqual(["Une idée", "Dé"]);
    expect(next.streams[conversation.id]?.streamId).toBe(streamId);
    expect(next.conversations[0]).toMatchObject({ id: conversation.id, preview: "Une idée", messageCount: 2 });
  });

  it("a send for a conversation no longer shown only updates the list and the stream", () => {
    const { other, state } = setup();
    const userMessage = makeMessage({ conversationId: other.id, role: "user", content: "Suite" });
    const assistantMessage = makeMessage({ conversationId: other.id, status: "streaming" });
    const next = applySendResult(
      state,
      { conversation: { ...other, updatedAt: 9_000 }, userMessage, assistantMessage, streamId: testId() },
      false,
    );
    expect(next.detail).toBe(state.detail);
    expect(next.streams[other.id]?.messageId).toBe(assistantMessage.id);
    expect(next.conversations[0]).toMatchObject({ id: other.id, messageCount: 4 });
  });

  it("a retry replaces the retried answer by the new streaming one", () => {
    const { active, answer } = setup();
    const failed = { ...answer, status: "error" as const };
    const state: ChatSlice = {
      streams: {},
      detail: { conversation: active, messages: [failed], usage: ZERO_USAGE },
      conversations: [],
    };
    const assistantMessage = makeMessage({ conversationId: active.id, status: "streaming" });
    const next = applyRetryResult(state, active.id, failed.id, { assistantMessage, streamId: testId() });
    expect(next.detail?.messages.map((message) => message.id)).toEqual([assistantMessage.id]);
    expect(next.streams[active.id]?.messageId).toBe(assistantMessage.id);
  });

  it("a reloaded detail keeps the more complete live draft over the lagging persisted text", () => {
    const { active, answer, stream } = setup();
    const state: ChatSlice = {
      streams: { [active.id]: { ...stream, draft: "Bonjour à toi", phase: "writing" } },
      detail: null,
      conversations: [],
    };
    const persisted = { ...answer, content: "Bonjour" };
    const next = applyLoadedDetail(state, { conversation: active, messages: [persisted], usage: ZERO_USAGE });
    expect(next.detail?.messages[0]?.content).toBe("Bonjour à toi");
  });
});

describe("reloading a streaming conversation", () => {
  it("keeps the text already on screen for a stream found after a reload", () => {
    const { active, answer, stream } = setup();
    const hydrated = { ...stream, fromStart: false, draft: " suite" };
    const onScreen = { ...answer, content: "Début suite" };
    const state: ChatSlice = {
      streams: { [active.id]: hydrated },
      detail: { conversation: active, messages: [onScreen], usage: ZERO_USAGE },
      conversations: [],
    };
    const next = applyLoadedDetail(state, {
      conversation: active,
      messages: [{ ...answer, content: "Début" }],
      usage: ZERO_USAGE,
    });
    expect(next.detail?.messages[0]?.content).toBe("Début suite");
  });
});
