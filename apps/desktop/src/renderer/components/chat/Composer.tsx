import { useId, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from "react";
import { Button } from "@nova/ui";
import type { ChatSendRequest } from "@nova/shared";
import { fr } from "../../copy/fr";
import { desktopCopy } from "../../copy/fr-desktop";
import { imageFilesOf } from "../../lib/vision";
import { ArrowUpIcon, StopIcon } from "../icons";
import { AutopilotCard } from "./autopilot/AutopilotCard";
import { autopilotExtras, isStale, nextStep } from "./autopilot/autopilot-state";
import type { AutopilotControl } from "./autopilot/useAutopilot";
import { ImageStrip } from "./vision/ImageStrip";
import type { ImageAttachments } from "./vision/useImageAttachments";

/** J2-B L7: what a message carries besides its text, for this message only (never stored). */
export type ChatSendExtras = Pick<ChatSendRequest, "reasoningEffort" | "images" | "webSearch">;

type SubmitMode = "enter" | "reclassify" | "without_autopilot";

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
  /**
   * Resolves true when the message left; the text is kept otherwise. `extras` (J2-B L7) is passed
   * only when the message carries images or an autopilot choice.
   */
  onSend: (content: string, extras?: ChatSendExtras) => Promise<boolean>;
  onStop: () => void;
  autoFocus?: boolean;
  /** Controlled text (a draft kept outside the composer); uncontrolled when omitted. */
  value?: string;
  onValueChange?: (value: string) => void;
  /** J2-B L7 (Discuter): images pasted for the next message (`useImageAttachments`). */
  images?: ImageAttachments;
  /** J2-B L7 (Discuter): the autopilot (`useAutopilot`); null or absent = sends directly. */
  autopilot?: AutopilotControl | null;
  /**
   * Slash commands (« /compact »): null when `content` is not one; otherwise the command runs
   * instead of a send (no autopilot, nothing sent) and resolves true when the text can be cleared.
   */
  command?: (content: string) => Promise<boolean> | null;
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
  images,
  autopilot,
  command,
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
  // The images wait for a model that can read them (the reason and its fix are shown).
  const block = blocked ?? images?.block ?? null;
  const canSend = content.length > 0 && !block && !streaming && !sending;
  /** The message now in the field, as the autopilot estimates it. */
  const subject = { content, images: images?.images.length ?? 0 };

  async function submit(mode: SubmitMode = "enter") {
    if (!canSend) return;
    const handled = command?.(content) ?? null;
    if (handled) {
      setSending(true);
      try {
        if (await handled) setValue("");
      } finally {
        setSending(false);
        textarea.current?.focus();
      }
      return;
    }
    const pasted = images?.images ?? [];
    const pilot = mode === "without_autopilot" ? null : (autopilot ?? null);
    if (pilot) {
      const step = mode === "reclassify" ? "classify" : nextStep(pilot.phase, subject);
      if (step === "wait") return;
      if (step === "classify") {
        // First Enter (or the message changed since): the choice is shown; the next Enter sends with it.
        await pilot.classify(subject);
        return;
      }
    }
    const extras: ChatSendExtras = {
      ...(pilot ? autopilotExtras(pilot.phase) : {}),
      ...(pasted.length > 0 ? { images: pasted } : {}),
    };
    setSending(true);
    try {
      const sent = Object.keys(extras).length > 0 ? await onSend(content, extras) : await onSend(content);
      if (sent) {
        setValue("");
        images?.clear();
        autopilot?.reset();
      }
    } finally {
      setSending(false);
      textarea.current?.focus();
    }
  }

  /** A pasted or dropped image joins the message; text is left to the field. */
  function takeImages(data: DataTransfer | null, event: ClipboardEvent | DragEvent): void {
    if (!images) return;
    const files = imageFilesOf(data);
    if (files.length === 0) return;
    event.preventDefault();
    void images.add(files);
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
  let hint: string = streaming ? fr.composer.stopHint : fr.composer.hint;
  if (!streaming && autopilot?.phase.kind === "idle") hint = desktopCopy.autopilot.hint;
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
        aria-describedby={block ? `${reasonId} ${hintId}` : hintId}
        // oxlint-disable-next-line jsx-a11y/no-autofocus -- the composer is the main task of its screen
        autoFocus={autoFocus}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={onKeyDown}
        onPaste={images ? (event) => takeImages(event.clipboardData, event) : undefined}
        onDragOver={images ? (event) => event.preventDefault() : undefined}
        onDrop={images ? (event) => takeImages(event.dataTransfer, event) : undefined}
      />
      {images ? <ImageStrip attachments={images} /> : null}
      {autopilot ? (
        <AutopilotCard
          control={autopilot}
          stale={isStale(autopilot.phase, subject)}
          busy={sending}
          onSend={() => void submit()}
          onSendWithout={() => void submit("without_autopilot")}
          onReclassify={() => void submit("reclassify")}
        />
      ) : null}
      <div className="nova-composer__bar">
        <p id={hintId} className="nova-composer__hint">
          {hint}
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
      {block ? (
        <p id={reasonId} className="nova-composer__reason">
          <span>{block.reason}</span>
          {block.action ? (
            <Button variant="ghost" size="sm" onClick={block.action.onAction}>
              {block.action.label}
            </Button>
          ) : null}
        </p>
      ) : null}
    </form>
  );
}
