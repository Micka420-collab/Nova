// Pure chat state transitions: streaming events, send/retry results, loaded details.
import type {
  ActiveStream,
  ChatRetryResult,
  ChatSendResult,
  ChatStreamEvent,
  ConversationDetail,
  ConversationSummary,
  Message,
  StreamPhase,
} from "@nova/shared";
import { toPreview } from "../lib/format";

export interface StreamView {
  streamId: string;
  messageId: string;
  phase: StreamPhase;
  /** Text received by this renderer for the stream. */
  draft: string;
  /** True when the renderer saw the stream from its start, so `draft` is the whole answer so far. */
  fromStart: boolean;
}

export interface ChatSlice {
  /** Active generations by conversation id (one per conversation). */
  streams: Record<string, StreamView>;
  /** Detail of the conversation shown in the chat view, if any. */
  detail: ConversationDetail | null;
  conversations: ConversationSummary[];
}

type TerminalEvent = Extract<ChatStreamEvent, { type: "completed" | "stopped" | "failed" }>;

function mapDetailMessage(
  detail: ConversationDetail | null,
  conversationId: string,
  messageId: string,
  update: (message: Message) => Message,
): ConversationDetail | null {
  if (!detail || detail.conversation.id !== conversationId) return detail;
  let changed = false;
  const messages = detail.messages.map((message) => {
    if (message.id !== messageId) return message;
    changed = true;
    return update(message);
  });
  return changed ? { ...detail, messages } : detail;
}

function withStream(streams: Record<string, StreamView>, conversationId: string, stream: StreamView) {
  return { ...streams, [conversationId]: stream };
}

function withoutStream(streams: Record<string, StreamView>, conversationId: string, streamId: string) {
  if (streams[conversationId]?.streamId !== streamId) return streams;
  const next = { ...streams };
  delete next[conversationId];
  return next;
}

/** Sorts like the store: most recently updated first. */
function sortSummaries(items: ConversationSummary[]): ConversationSummary[] {
  return [...items].sort((a, b) => b.updatedAt - a.updatedAt);
}

function applyTerminal(state: ChatSlice, event: TerminalEvent): ChatSlice {
  const { conversationId, message } = event;
  let detail = state.detail;
  if (detail && detail.conversation.id === conversationId) {
    const exists = detail.messages.some((item) => item.id === message.id);
    detail = {
      ...detail,
      messages: exists
        ? detail.messages.map((item) => (item.id === message.id ? message : item))
        : [...detail.messages, message],
    };
  }
  const summary = state.conversations.find((item) => item.id === conversationId);
  const conversations = summary
    ? sortSummaries(
        state.conversations.map((item) =>
          item.id === conversationId
            ? {
                ...item,
                updatedAt: Math.max(item.updatedAt, message.updatedAt),
                preview: toPreview(message.content) ?? item.preview,
              }
            : item,
        ),
      )
    : state.conversations;
  return { streams: withoutStream(state.streams, conversationId, event.streamId), detail, conversations };
}

export function applyChatEvent(state: ChatSlice, event: ChatStreamEvent): ChatSlice {
  switch (event.type) {
    case "phase": {
      const current = state.streams[event.conversationId];
      const same = current?.streamId === event.streamId;
      const stream: StreamView = same
        ? { ...current, phase: event.phase }
        : {
            streamId: event.streamId,
            messageId: event.messageId,
            phase: event.phase,
            draft: "",
            fromStart: event.phase === "waiting",
          };
      return { ...state, streams: withStream(state.streams, event.conversationId, stream) };
    }
    case "delta": {
      const current = state.streams[event.conversationId];
      const stream: StreamView =
        current?.streamId === event.streamId
          ? { ...current, phase: "writing", draft: current.draft + event.text }
          : {
              streamId: event.streamId,
              messageId: event.messageId,
              phase: "writing",
              draft: event.text,
              fromStart: false,
            };
      return {
        ...state,
        streams: withStream(state.streams, event.conversationId, stream),
        detail: mapDetailMessage(state.detail, event.conversationId, event.messageId, (message) => ({
          ...message,
          content: message.content + event.text,
        })),
      };
    }
    case "meta":
      return {
        ...state,
        detail: mapDetailMessage(state.detail, event.conversationId, event.messageId, (message) => ({
          ...message,
          servedModel: event.servedModel,
          servedProvider: event.servedProvider,
        })),
      };
    case "usage":
      return {
        ...state,
        detail: mapDetailMessage(state.detail, event.conversationId, event.messageId, (message) => ({
          ...message,
          usage: event.usage,
        })),
      };
    case "completed":
    case "stopped":
    case "failed":
      return applyTerminal(state, event);
  }
}

/** The message as the renderer knows it: text received before the send result arrived is kept. */
function withKnownDraft(message: Message, stream: StreamView | undefined): Message {
  return stream && stream.messageId === message.id && stream.draft.length > message.content.length
    ? { ...message, content: stream.draft }
    : message;
}

function startedStream(streams: Record<string, StreamView>, conversationId: string, streamId: string, messageId: string) {
  const current = streams[conversationId];
  if (current?.streamId === streamId) return streams;
  return withStream(streams, conversationId, { streamId, messageId, phase: "waiting", draft: "", fromStart: true });
}

/**
 * Applies `chat.send`'s result. `show` says whether the chat view displays this conversation
 * (it may have navigated elsewhere while the request was in flight).
 */
export function applySendResult(state: ChatSlice, result: ChatSendResult, show: boolean): ChatSlice {
  const { conversation, userMessage, assistantMessage, streamId } = result;
  const streams = startedStream(state.streams, conversation.id, streamId, assistantMessage.id);
  const assistant = withKnownDraft(assistantMessage, streams[conversation.id]);
  let detail = state.detail;
  if (show) {
    const base: ConversationDetail =
      detail && detail.conversation.id === conversation.id
        ? detail
        : {
            conversation,
            messages: [],
            usage: { promptTokens: 0, completionTokens: 0, cost: 0, messagesWithUnknownCost: 0 },
          };
    const known = new Set(base.messages.map((message) => message.id));
    const added = [userMessage, assistant].filter((message) => !known.has(message.id));
    detail = { ...base, conversation, messages: [...base.messages, ...added] };
  }
  const previous = state.conversations.find((item) => item.id === conversation.id);
  const summary: ConversationSummary = {
    ...conversation,
    messageCount: (previous?.messageCount ?? 0) + 2,
    preview: toPreview(userMessage.content),
  };
  const conversations = sortSummaries([summary, ...state.conversations.filter((item) => item.id !== conversation.id)]);
  return { streams, detail, conversations };
}

/** Applies `chat.retry`'s result: the retried answer is replaced by the new one. */
export function applyRetryResult(
  state: ChatSlice,
  conversationId: string,
  retriedMessageId: string,
  result: ChatRetryResult,
): ChatSlice {
  const streams = startedStream(state.streams, conversationId, result.streamId, result.assistantMessage.id);
  let detail = state.detail;
  if (detail && detail.conversation.id === conversationId) {
    const assistant = withKnownDraft(result.assistantMessage, streams[conversationId]);
    const kept = detail.messages.filter((message) => message.id !== retriedMessageId && message.id !== assistant.id);
    detail = { ...detail, messages: [...kept, assistant] };
  }
  return { ...state, streams, detail };
}

/**
 * Applies a freshly loaded detail. Persisted partial answers lag behind the stream (writes are
 * throttled): the streaming message keeps the longest text known, all of them being prefixes of
 * the answer (whole draft of a stream seen from its start, text already on screen, persisted text).
 */
export function applyLoadedDetail(state: ChatSlice, detail: ConversationDetail): ChatSlice {
  const stream = state.streams[detail.conversation.id];
  if (!stream) return { ...state, detail };
  const shown = state.detail?.conversation.id === detail.conversation.id ? state.detail : null;
  const messages = detail.messages.map((message) => {
    if (message.id !== stream.messageId || message.status !== "streaming") return message;
    const candidates = [shown?.messages.find((item) => item.id === message.id)?.content ?? ""];
    if (stream.fromStart) candidates.push(stream.draft);
    const longest = candidates.reduce((best, text) => (text.length > best.length ? text : best), message.content);
    return longest === message.content ? message : { ...message, content: longest };
  });
  return { ...state, detail: { ...detail, messages } };
}

/** Streams found by `chat.active()` at startup; streams already known through events are kept. */
export function applyActiveStreams(state: ChatSlice, active: ActiveStream[]): ChatSlice {
  let streams = state.streams;
  for (const item of active) {
    if (streams[item.conversationId]) continue;
    streams = withStream(streams, item.conversationId, {
      streamId: item.streamId,
      messageId: item.messageId,
      phase: item.phase,
      draft: "",
      fromStart: false,
    });
  }
  return streams === state.streams ? state : { ...state, streams };
}
