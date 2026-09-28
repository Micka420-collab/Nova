// Chat autopilot control for the composer (J2-B L7). Null while the autopilot is off
// (`settings.chat.autopilot`) or main does not serve it: the composer then sends as before.
import { useCallback, useReducer, useState } from "react";
import { AUTOPILOT_LIMITS } from "@nova/shared";
import { useClient, useApp } from "../../../state/context";
import { isUnavailableError, useDesktopSlice, desktopStoreFor } from "../../../state/desktop-slice";
import { AUTOPILOT_IDLE, autopilotReducer, type AutopilotAction, type AutopilotPhase, type AutopilotSubject } from "./autopilot-state";

export interface AutopilotControl {
  phase: AutopilotPhase;
  classify: (subject: AutopilotSubject) => Promise<void>;
  dispatch: (action: AutopilotAction) => void;
  reset: () => void;
}

/** `conversationKey`: switching conversation drops a choice made for another message. */
export function useAutopilot(conversationKey: string | null, modelId: string | null): AutopilotControl | null {
  const client = useClient();
  const enabled = useApp((state) => state.settings?.chat.autopilot === true);
  const wired = useDesktopSlice((state) => state.availability === "available" && !state.autopilotUnavailable);
  const [phase, dispatch] = useReducer(autopilotReducer, AUTOPILOT_IDLE);
  // A choice belongs to one message of one conversation with one model: another scope drops it
  // (adjusted during render, so a stale choice is never shown for one frame).
  const scope = `${conversationKey ?? "new"}|${modelId ?? ""}`;
  const [shownScope, setShownScope] = useState(scope);
  if (shownScope !== scope) {
    setShownScope(scope);
    dispatch({ type: "reset" });
  }

  const classify = useCallback(
    async (subject: AutopilotSubject) => {
      if (!modelId) return;
      dispatch({ type: "classify", subject });
      try {
        const choice = await client.autopilot.classify({
          content: subject.content.slice(0, AUTOPILOT_LIMITS.excerptMaxChars),
          modelId,
          hasImages: subject.images > 0,
        });
        dispatch({ type: "classified", choice });
      } catch (error) {
        const unavailable = isUnavailableError(error);
        if (unavailable) desktopStoreFor(client).getState().markAutopilotUnavailable();
        dispatch({ type: "failed", unavailable });
      }
    },
    [client, modelId],
  );
  const reset = useCallback(() => dispatch({ type: "reset" }), []);

  // Keep the failure visible even once main said `unavailable` (the control would vanish otherwise).
  if (!enabled || (!wired && phase.kind !== "failed")) return null;
  return { phase, classify, dispatch, reset };
}
