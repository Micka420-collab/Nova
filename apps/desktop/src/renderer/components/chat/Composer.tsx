import { useId, useRef, useState, type KeyboardEvent } from "react";
import { Button } from "@nova/ui";
import { fr } from "../../copy/fr";
import { ArrowUpIcon, StopIcon } from "../icons";

export interface ComposerBlock {
  reason: string;
  action?: { label: string; onAction: () => void };
}

export interface ComposerProps {
  label: string;
  placeholder?: string;
  /** A generation runs in this conversation: Stop replaces Send, Escape stops. */
  streaming: boolean;
  /** Why sending is impossible right now; shown next to the disabled button. */
  blocked: ComposerBlock | null;
  /** Resolves true when the message left; the text is kept otherwise. */
  onSend: (content: string) => Promise<boolean>;
  onStop: () => void;
  autoFocus?: boolean;
  /** Controlled text (a draft kept outside the composer); uncontrolled when omitted. */
  value?: string;
  onValueChange?: (value: string) => void;
}

export function Composer({
  label,
  placeholder,
  streaming,
  blocked,
  onSend,
  onStop,
  autoFocus,
  value: controlled,
  onValueChange,
}: ComposerProps) {
  const id = useId();
  const textarea = useRef<HTMLTextAreaElement>(null);
  const [local, setLocal] = useState("");
  const value = controlled ?? local;
  const setValue = (next: string) => {
    if (controlled === undefined) setLocal(next);
    onValueChange?.(next);
  };
  const [sending, setSending] = useState(false);
  const content = value.trim();
  const canSend = content.length > 0 && !blocked && !streaming && !sending;

  async function submit() {
    if (!canSend) return;
    setSending(true);
    try {
      if (await onSend(content)) setValue("");
    } finally {
      setSending(false);
      textarea.current?.focus();
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
    } else if (event.key === "Escape" && streaming) {
      event.preventDefault();
      onStop();
    }
  }

  const hintId = `${id}-hint`;
  const reasonId = `${id}-reason`;
  return (
    <form
      className="nova-composer"
      aria-label={label}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <label htmlFor={id} className="nv-visually-hidden">
        {label}
      </label>
      {/* Grows with its content through CSS field-sizing (no inline style under the CSP). */}
      <textarea
        ref={textarea}
        id={id}
        className="nova-composer__input"
        rows={1}
        value={value}
        placeholder={placeholder ?? fr.composer.placeholder}
        aria-describedby={blocked ? `${reasonId} ${hintId}` : hintId}
        // oxlint-disable-next-line jsx-a11y/no-autofocus -- the composer is the main task of its screen
        autoFocus={autoFocus}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className="nova-composer__bar">
        <p id={hintId} className="nova-composer__hint">
          {streaming ? fr.composer.stopHint : fr.composer.hint}
        </p>
        {streaming ? (
          <Button variant="secondary" size="sm" icon={<StopIcon size={14} />} onClick={onStop}>
            {fr.composer.stop}
          </Button>
        ) : (
          <Button
            type="submit"
            variant="primary"
            size="sm"
            loading={sending}
            disabled={!canSend}
            icon={<ArrowUpIcon size={16} />}
          >
            {fr.composer.send}
          </Button>
        )}
      </div>
      {blocked ? (
        <p id={reasonId} className="nova-composer__reason">
          <span>{blocked.reason}</span>
          {blocked.action ? (
            <Button variant="ghost" size="sm" onClick={blocked.action.onAction}>
              {blocked.action.label}
            </Button>
          ) : null}
        </p>
      ) : null}
    </form>
  );
}
