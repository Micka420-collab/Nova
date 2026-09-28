// Chat autopilot flow (J2-B L7), pure: a first Enter asks main for a choice (reasoning effort, web),
// the choice is shown and can be changed, a second Enter sends with it. A failure never sends on
// its own: it is shown, and the user retries or sends without the autopilot. A choice belongs to
// the message it was estimated for: once the text or the pasted images change, it is stale and the
// next Enter estimates again (never sends another message with it).
import type { AutopilotChoice, ReasoningEffort } from "@nova/shared";

/** What a choice was estimated for: the trimmed text and the number of pasted images. */
export interface AutopilotSubject {
  content: string;
  images: number;
}

export type AutopilotPhase =
  | { kind: "idle" }
  | { kind: "classifying"; subject: AutopilotSubject }
  | {
      kind: "ready";
      subject: AutopilotSubject;
      choice: AutopilotChoice;
      /** What will be sent (the choice, or the user's override). */
      reasoningEffort: ReasoningEffort | null;
      webSearch: boolean;
    }
  /** `unavailable`: main does not serve the autopilot (the next Enter sends without it). */
  | { kind: "failed"; unavailable: boolean };

export type AutopilotAction =
  | { type: "classify"; subject: AutopilotSubject }
  | { type: "classified"; choice: AutopilotChoice }
  | { type: "failed"; unavailable: boolean }
  | { type: "effort"; value: ReasoningEffort }
  | { type: "web"; value: boolean }
  | { type: "reset" };

export const AUTOPILOT_IDLE: AutopilotPhase = { kind: "idle" };

export function autopilotReducer(phase: AutopilotPhase, action: AutopilotAction): AutopilotPhase {
  switch (action.type) {
    case "classify":
      return { kind: "classifying", subject: action.subject };
    case "classified":
      // A late answer after a reset (message sent or dismissed) is ignored.
      if (phase.kind !== "classifying") return phase;
      return {
        kind: "ready",
        subject: phase.subject,
        choice: action.choice,
        reasoningEffort: action.choice.reasoningEffort,
        webSearch: action.choice.webSearch,
      };
    case "failed":
      return phase.kind === "classifying" ? { kind: "failed", unavailable: action.unavailable } : phase;
    case "effort":
      // No effort for a model that cannot reason (the choice says null): nothing to override.
      if (phase.kind !== "ready" || phase.choice.reasoningEffort === null) return phase;
      return { ...phase, reasoningEffort: action.value };
    case "web":
      return phase.kind === "ready" ? { ...phase, webSearch: action.value } : phase;
    case "reset":
      return AUTOPILOT_IDLE;
  }
}

/** A ready choice estimated for another text or other images than the message now in the field. */
export function isStale(phase: AutopilotPhase, subject: AutopilotSubject): boolean {
  return phase.kind === "ready" && (phase.subject.content !== subject.content || phase.subject.images !== subject.images);
}

/** What the next Enter does in this phase, for the message now in the field. */
export function nextStep(phase: AutopilotPhase, subject: AutopilotSubject): "classify" | "wait" | "send" | "send_without" {
  switch (phase.kind) {
    case "idle":
      return "classify";
    case "classifying":
      return "wait";
    case "ready":
      return isStale(phase, subject) ? "classify" : "send";
    case "failed":
      return phase.unavailable ? "send_without" : "classify";
  }
}

/** The request fields of a ready choice (as overridden); empty otherwise. */
export function autopilotExtras(phase: AutopilotPhase): { reasoningEffort?: ReasoningEffort | null; webSearch?: boolean } {
  if (phase.kind !== "ready") return {};
  return { reasoningEffort: phase.reasoningEffort, webSearch: phase.webSearch };
}
