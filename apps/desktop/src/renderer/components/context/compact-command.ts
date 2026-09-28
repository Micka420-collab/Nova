// « /compact [consigne] » typed in the composer (Discuter): asks main for a summary proposal.
// Pure parser; the composer (lane L7) calls it before sending and routes a match to
// `useCompactAction` instead of sending a message.
import { COMPACTION_LIMITS } from "@nova/shared";

export type CompactCommand =
  | { kind: "compact"; instructions: string | null }
  /** Refused, never truncated: the user's instructions are sent whole or not at all. */
  | { kind: "too_long"; max: number };

const COMMAND = /^\/compact(?:\s+([\s\S]*))?$/u;

export function parseCompactCommand(text: string): CompactCommand | null {
  const match = COMMAND.exec(text.trim());
  if (!match) return null;
  const instructions = match[1]?.trim() ?? "";
  if (instructions.length > COMPACTION_LIMITS.instructionsMaxChars) {
    return { kind: "too_long", max: COMPACTION_LIMITS.instructionsMaxChars };
  }
  return { kind: "compact", instructions: instructions === "" ? null : instructions };
}
