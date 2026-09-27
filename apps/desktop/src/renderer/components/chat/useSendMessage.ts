import { useCallback, useState } from "react";
import type { ErrorCopy } from "../../copy/fr";
import { describeUiError, toUiError } from "../../lib/errors";
import { useApp } from "../../state/context";

export interface SendError {
  /** Conversation the failed message was meant for (null = a new conversation). */
  conversationId: string | null;
  copy: ErrorCopy;
}

/** Sends through the store; a failure is kept for an inline callout and the text stays in the composer. */
export function useSendMessage(): {
  send: (content: string, conversationId: string | null) => Promise<boolean>;
  error: SendError | null;
} {
  const sendMessage = useApp((state) => state.send);
  const [error, setError] = useState<SendError | null>(null);
  const send = useCallback(
    async (content: string, conversationId: string | null) => {
      setError(null);
      try {
        await sendMessage(content, conversationId);
        return true;
      } catch (caught) {
        setError({ conversationId, copy: describeUiError(toUiError(caught)) });
        return false;
      }
    },
    [sendMessage],
  );
  return { send, error };
}
