// Assembly of streamed tool calls and reasoning blocks into complete assistant turn data.
import { asCount, asRecord } from "./coerce";
import type { ChatToolCall, ProviderStreamEvent } from "./types";

/** Hard cap on the arguments of one call (a runaway model must not exhaust memory). */
export const TOOL_ARGUMENTS_MAX_CHARS = 1_000_000;
/** Hard cap on the number of calls in one turn. */
export const TOOL_CALLS_MAX_PER_TURN = 32;

interface PartialCall {
  id: string | null;
  name: string | null;
  arguments: string;
  overflow: boolean;
}

export interface AssembledToolCall extends ChatToolCall {
  /** True when the arguments exceeded TOOL_ARGUMENTS_MAX_CHARS (the call must not be executed). */
  overflow: boolean;
}

/**
 * Accumulates `tool_call_delta` events by index. Fragments may be split anywhere (inside JSON
 * strings, escapes or multi-byte characters: they are already decoded text). A call without an id
 * gets a stable synthetic one so the transcript stays consistent.
 */
export class ToolCallAssembler {
  private readonly calls = new Map<number, PartialCall>();

  push(event: Extract<ProviderStreamEvent, { type: "tool_call_delta" }>): void {
    let call = this.calls.get(event.index);
    if (!call) {
      if (this.calls.size >= TOOL_CALLS_MAX_PER_TURN) return;
      call = { id: null, name: null, arguments: "", overflow: false };
      this.calls.set(event.index, call);
    }
    if (event.id && !call.id) call.id = event.id;
    if (event.name && !call.name) call.name = event.name;
    if (call.overflow) return;
    if (call.arguments.length + event.argumentsDelta.length > TOOL_ARGUMENTS_MAX_CHARS) {
      call.overflow = true;
      call.arguments = "";
      return;
    }
    call.arguments += event.argumentsDelta;
  }

  get size(): number {
    return this.calls.size;
  }

  /** Complete calls in index order. Calls that never received a name are dropped (unusable). */
  finish(): AssembledToolCall[] {
    return [...this.calls.entries()]
      .sort(([a], [b]) => a - b)
      .filter((entry): entry is [number, PartialCall & { name: string }] => entry[1].name !== null)
      .map(([index, call]) => ({
        id: call.id ?? `call_${index}`,
        name: call.name,
        arguments: call.arguments,
        overflow: call.overflow,
      }));
  }
}

const CONCATENATED_FIELDS = ["text", "summary", "data"] as const;

/**
 * Merges streamed `reasoning_details` pieces: entries sharing an `index` (or, without one, their
 * position) are one block whose text/summary/data fragments concatenate; other fields keep their
 * first non-null value. The result is sent back unchanged in the next request.
 */
export function mergeReasoningDetails(pieces: readonly unknown[]): unknown[] {
  const blocks = new Map<number, Record<string, unknown>>();
  let position = 0;
  for (const piece of pieces) {
    const record = asRecord(piece);
    if (!record) continue;
    const key = asCount(record.index) ?? position++;
    const block = blocks.get(key);
    if (!block) {
      blocks.set(key, { ...record });
      continue;
    }
    for (const [field, value] of Object.entries(record)) {
      const existing = block[field];
      if ((CONCATENATED_FIELDS as readonly string[]).includes(field) && typeof value === "string") {
        block[field] = typeof existing === "string" ? existing + value : value;
      } else if (existing === undefined || existing === null) {
        block[field] = value;
      }
    }
  }
  return [...blocks.entries()].sort(([a], [b]) => a - b).map(([, block]) => block);
}
