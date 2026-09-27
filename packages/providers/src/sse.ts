// Incremental Server-Sent Events decoding over a fetch body.
import { createParser } from "eventsource-parser";
import { providerErrorInfo } from "./errors";
import { ProviderError } from "./types";

export type SseItem = { kind: "data"; data: string } | { kind: "comment"; text: string };

export interface ReadSseOptions {
  /** Aborting cancels the underlying stream. */
  signal?: AbortSignal;
  /** Called for every non-empty byte chunk received, before decoding (keep-alives included). */
  onBytes?: () => void;
}

/** Guards memory against a peer that never terminates a line or an event. */
const MAX_SSE_BUFFER_CHARS = 16 * 1024 * 1024;

/**
 * Yields the stream's byte chunks. Aborting `signal` cancels the stream and makes the iteration
 * throw the abort reason instead of ending cleanly; exiting early (break/return/throw) always
 * cancels the stream so the connection is released.
 */
export async function* readChunks(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<Uint8Array, void, undefined> {
  const reader = stream.getReader();
  const cancel = (): void => {
    reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    signal?.throwIfAborted();
    for (;;) {
      const { done, value } = await reader.read();
      // A cancel triggered by the abort resolves the pending read as done: report the abort instead.
      signal?.throwIfAborted();
      if (done) return;
      if (value.byteLength > 0) yield value;
    }
  } finally {
    signal?.removeEventListener("abort", cancel);
    cancel();
    reader.releaseLock();
  }
}

/**
 * Decodes an SSE byte stream into data payloads and comments. Robust to chunks split anywhere
 * (inside UTF-8 sequences, field names or line terminators) and to CRLF/CR line endings.
 * An event not terminated by a blank line before the stream ends is discarded, per the SSE spec.
 */
export async function* readSse(
  stream: ReadableStream<Uint8Array>,
  options: ReadSseOptions = {},
): AsyncGenerator<SseItem, void, undefined> {
  const queue: SseItem[] = [];
  let overflow = false;
  const parser = createParser({
    maxBufferSize: MAX_SSE_BUFFER_CHARS,
    onEvent: (event) => queue.push({ kind: "data", data: event.data }),
    onComment: (text) => queue.push({ kind: "comment", text }),
    onError: (error) => {
      if (error.type === "max-buffer-size-exceeded") overflow = true;
    },
  });
  const decoder = new TextDecoder();
  for await (const chunk of readChunks(stream, options.signal)) {
    options.onBytes?.();
    parser.feed(decoder.decode(chunk, { stream: true }));
    if (overflow) {
      throw new ProviderError(providerErrorInfo("provider_error"), "SSE buffer limit exceeded");
    }
    yield* queue.splice(0);
  }
  parser.feed(decoder.decode());
  yield* queue.splice(0);
}
