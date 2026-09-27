import { useCallback } from "react";
import type { UiError } from "../../lib/errors";
import { useApp } from "../../state/context";
import { NEW_CONVERSATION } from "../../state/store";

/**
 * The composer draft of `conversationId` (null = a new conversation), kept in the store: its text
 * and the error of its last failed send survive navigation together and end together.
 */
export function useSendMessage(conversationId: string | null): {
  text: string;
  setText: (text: string) => void;
  send: (content: string) => Promise<boolean>;
  error: UiError | null;
} {
  const key = conversationId ?? NEW_CONVERSATION;
  const draft = useApp((state) => state.drafts[key] ?? null);
  const setDraft = useApp((state) => state.setDraft);
  const sendDraft = useApp((state) => state.sendDraft);
  const setText = useCallback((text: string) => setDraft(conversationId, text), [setDraft, conversationId]);
  const send = useCallback((content: string) => sendDraft(content, conversationId), [sendDraft, conversationId]);
  return { text: draft?.text ?? "", setText, send, error: draft?.error ?? null };
}
