// What a summary is written from: the covered messages as neutral transcript entries, with big
// tool results pruned to head + tail (COMPACTION_LIMITS). Every pruning is listed; nothing is
// pruned silently. Stored history is never touched: this only shapes the summarizer's input.
import { createHash } from "node:crypto";
import { COMPACTION_LIMITS, type Message, type PrunedToolResult } from "@nova/shared";
import { CHARS_PER_TOKEN } from "../context-plan";
import type { ProxyMessage } from "../index";

/** Same shape as `CompactionTranscriptEntry` of @nova/agent-runtime (the prompt builder). */
export interface TranscriptEntry {
  role: "user" | "assistant" | "tool" | "summary";
  content: string;
  label: string | null;
}

export interface PruneLimits {
  thresholdChars: number;
  keepChars: number;
}

const DEFAULT_PRUNE: PruneLimits = {
  thresholdChars: COMPACTION_LIMITS.pruneThresholdChars,
  keepChars: COMPACTION_LIMITS.pruneKeepChars,
};

/** Head + marker + tail of a text above the threshold; null when it is kept whole. */
export function pruneText(text: string, limits: PruneLimits = DEFAULT_PRUNE): { content: string; keptChars: number } | null {
  if (text.length <= limits.thresholdChars) return null;
  const head = text.slice(0, limits.keepChars);
  const tail = text.slice(text.length - limits.keepChars);
  const dropped = text.length - head.length - tail.length;
  return { content: `${head}\n[… ${dropped} characters pruned …]\n${tail}`, keptChars: head.length + tail.length };
}

export function approxTokens(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

export function messageChars(message: ProxyMessage): number {
  if (message.role !== "assistant") return message.content.length;
  return message.content.length + message.toolCalls.reduce((sum, call) => sum + call.name.length + call.arguments.length, 0);
}

/** Mission transcript → entries; tool results above the threshold are pruned and listed. */
export function missionTranscript(
  messages: readonly ProxyMessage[],
  limits: PruneLimits = DEFAULT_PRUNE,
): { entries: TranscriptEntry[]; pruned: PrunedToolResult[] } {
  const toolNames = new Map<string, string>();
  const entries: TranscriptEntry[] = [];
  const pruned: PrunedToolResult[] = [];
  for (const message of messages) {
    switch (message.role) {
      case "system":
        // The system prompt is kept as is by the replacement; it is not summarized.
        break;
      case "user":
        entries.push({ role: "user", content: message.content, label: null });
        break;
      case "assistant": {
        for (const call of message.toolCalls) toolNames.set(call.id, call.name);
        const calls = message.toolCalls.map((call) => `${call.name}(${call.arguments.slice(0, 300)})`);
        const content = [message.content, ...calls].filter(Boolean).join("\n");
        // Reasoning details are never part of a summary (ADR-008).
        entries.push({ role: "assistant", content, label: message.toolCalls.length > 0 ? message.toolCalls.map((call) => call.name).join(", ") : null });
        break;
      }
      case "tool": {
        const tool = toolNames.get(message.toolCallId) ?? "tool";
        const cut = pruneText(message.content, limits);
        if (cut) {
          pruned.push({ toolCallId: message.toolCallId, tool, originalChars: message.content.length, keptChars: cut.keptChars, artifactId: null });
        }
        entries.push({ role: "tool", content: cut ? cut.content : message.content, label: tool });
        break;
      }
    }
  }
  return { entries, pruned };
}

/** Conversation messages → entries (an earlier applied summary comes first, marked as such). */
export function conversationTranscript(messages: readonly Message[], earlierSummary: string | null): TranscriptEntry[] {
  const entries: TranscriptEntry[] = earlierSummary ? [{ role: "summary", content: earlierSummary, label: null }] : [];
  for (const message of messages) {
    if (message.content === "") continue;
    const cut = message.role === "assistant" ? pruneText(message.content) : null;
    entries.push({ role: message.role, content: cut ? cut.content : message.content, label: null });
  }
  return entries;
}

/**
 * Identity of a transcript prefix: a summary replaces exactly the messages it was written from,
 * so applying it checks that the runtime's transcript still starts with them.
 */
export function transcriptFingerprint(messages: readonly ProxyMessage[]): string {
  const hash = createHash("sha256");
  for (const message of messages) {
    hash.update(message.role);
    hash.update("\u0000");
    hash.update(message.content);
    if (message.role === "assistant") for (const call of message.toolCalls) hash.update(`\u0001${call.id}\u0002${call.name}\u0002${call.arguments}`);
    if (message.role === "tool") hash.update(`\u0003${message.toolCallId}`);
    hash.update("\u0004");
  }
  return hash.digest("hex");
}
