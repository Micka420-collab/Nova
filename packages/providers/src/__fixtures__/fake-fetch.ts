// Test doubles: scripted byte streams and a recording fetch. Test-only.
import type { FetchLike } from "../openrouter";

/** A string/bytes step is enqueued as one chunk; a number step waits that many milliseconds. */
export type StreamStep = string | Uint8Array | number;

export interface ScriptedStream {
  stream: ReadableStream<Uint8Array>;
  /** True once the consumer cancelled the stream (connection released). */
  readonly cancelled: boolean;
}

const encoder = new TextEncoder();

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A pull-driven stream; with `hang`, it never closes after the last step. */
export function scriptedStream(steps: StreamStep[], options: { hang?: boolean } = {}): ScriptedStream {
  let index = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        while (index < steps.length) {
          const step = steps[index++];
          if (step === undefined) break;
          if (typeof step === "number") {
            await delay(step);
            continue;
          }
          if (cancelled) return;
          controller.enqueue(typeof step === "string" ? encoder.encode(step) : step);
          return;
        }
        if (options.hang) return new Promise<void>(() => undefined);
        controller.close();
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return {
    stream,
    get cancelled() {
      return cancelled;
    },
  };
}

/** Encodes `text` and cuts it every `size` bytes (splitting UTF-8 sequences and lines anywhere). */
export function splitBytes(text: string, size: number): Uint8Array[] {
  const bytes = encoder.encode(text);
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.length; offset += size) chunks.push(bytes.slice(offset, offset + size));
  return chunks;
}

/** One SSE `data:` event per payload. */
export function sseData(...payloads: unknown[]): string {
  return payloads.map((payload) => `data: ${typeof payload === "string" ? payload : JSON.stringify(payload)}\n\n`).join("");
}

export interface RecordedRequest {
  url: string;
  init: RequestInit;
}

export function recordingFetch(respond: (request: RecordedRequest) => Response | Promise<Response>): {
  fetch: FetchLike;
  calls: RecordedRequest[];
} {
  const calls: RecordedRequest[] = [];
  return {
    calls,
    fetch: async (url, init) => {
      const request = { url, init };
      calls.push(request);
      return respond(request);
    },
  };
}

/** Like a real fetch waiting for headers: settles only when the request signal aborts. */
export function pendingUntilAborted(init: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    init.signal?.addEventListener("abort", () => reject(new DOMException("This operation was aborted", "AbortError")), {
      once: true,
    });
  });
}

export function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

export function sseResponse(stream: ReadableStream<Uint8Array>): Response {
  return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}
