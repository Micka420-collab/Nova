import { useCallback } from "react";
import type { UiError } from "../../lib/errors";
import { useApp } from "../../state/context";
import { NEW_CONVERSATION } from "../../state/store";
import type { ChatSendExtras } from "./Composer";

/**
 * `sendDraft` as the chat needs it (J2-B L7): the extras of one message (images, reasoning effort,
 * the autopilot's web choice) go to `chat.send` with it. Declared here so the composer compiles
 * against the store before and after the store forwards `extras` (lane map contract request).
 */
type SendDraft = (content: string, conversationId: string | null, extras?: ChatSendExtras) => Promise<boolean>;

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
  const sendDraft: SendDraft = useApp((state) => state.sendDraft);
  const setText = useCallback((text: string) => setDraft(conversationId, text), [setDraft, conversationId]);
  const send = useCallback(
    (content: string, extras?: ChatSendExtras) => (extras ? sendDraft(content, conversationId, extras) : sendDraft(content, conversationId)),
    [sendDraft, conversationId],
  );
  return { text: draft?.text ?? "", setText, send, error: draft?.error ?? null };
}
