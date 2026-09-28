import { useCallback } from "react";
import type { UiError } from "../../lib/errors";
import { useApp } from "../../state/context";
import { NEW_CONVERSATION } from "../../state/store";
import type { ChatSendExtras } from "./Composer";

/**
 * The composer draft of `conversationId` (null = a new conversation), kept in the store: its text
 * and the error of its last failed send survive navigation together and end together.
 */
export function useSendMessage(conversationId: string | null): {
  text: string;
  setText: (text: string) => void;
  send: (content: string, extras?: ChatSendExtras) => Promise<boolean>;
  error: UiError | null;
} {
  const key = conversationId ?? NEW_CONVERSATION;
  const draft = useApp((state) => state.drafts[key] ?? null);
  const setDraft = useApp((state) => state.setDraft);
  // J2-B L7: the extras of one message (images, reasoning effort, the autopilot's web choice).
  const sendDraft = useApp((state) => state.sendDraft);
  const setText = useCallback((text: string) => setDraft(conversationId, text), [setDraft, conversationId]);
  const send = useCallback(
    (content: string, extras?: ChatSendExtras) => (extras ? sendDraft(content, conversationId, extras) : sendDraft(content, conversationId)),
    [sendDraft, conversationId],
  );
  return { text: draft?.text ?? "", setText, send, error: draft?.error ?? null };
}
