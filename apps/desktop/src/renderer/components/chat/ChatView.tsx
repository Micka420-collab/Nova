import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button, Callout, EmptyState, IconButton, Skeleton, useToast } from "@nova/ui";
import type { Message } from "@nova/shared";
import { fr } from "../../copy/fr";
import { describeUiError, errorToast } from "../../lib/errors";
import { useApp } from "../../state/context";
import type { StreamView } from "../../state/chat-reducer";
import { selectedModelId } from "../../state/store";
import { ChevronDownIcon, PanelRightIcon, PencilIcon } from "../icons";
import { findModel } from "../models/filter";
import { ContextInspector, MentionPicker, useMentionPicker } from "../agent/GoalContext";
import { Composer } from "./Composer";
import { MessageItem } from "./MessageItem";
import { SendFailure } from "./SendFailure";
import { useSendGuard } from "./useSendGuard";
import { useSendMessage } from "./useSendMessage";

const STICK_THRESHOLD_PX = 64;

function TitleEditor({ id, title }: { id: string; title: string }) {
  const rename = useApp((state) => state.rename);
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(title);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const next = value.trim();
    if (!next || next === title) {
      setEditing(false);
      return;
    }
    setBusy(true);
    try {
      await rename(id, next);
      setEditing(false);
    } catch (error) {
      toast.show(errorToast(error, fr.conversation.renameTitle));
    } finally {
      setBusy(false);
    }
  }

  if (!editing) {
    return (
      <div className="nova-chat__title-row">
        <h1 className="nova-chat__title">{title}</h1>
        <IconButton
          aria-label={fr.chat.editTitle}
          icon={<PencilIcon size={15} />}
          size="sm"
          onClick={() => {
            setValue(title);
            setEditing(true);
          }}
        />
      </div>
    );
  }
  return (
    <form className="nova-chat__title-form" onSubmit={(event) => void submit(event)}>
      <label className="nv-visually-hidden" htmlFor={`title-${id}`}>
        {fr.conversation.renameLabel}
      </label>
      <input
        id={`title-${id}`}
        className="nv-field__control nova-chat__title-input"
        value={value}
        maxLength={120}
        // oxlint-disable-next-line jsx-a11y/no-autofocus -- the user just asked to edit this field
        autoFocus
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            setEditing(false);
          }
        }}
      />
      <Button type="submit" size="sm" variant="primary" loading={busy}>
        {fr.app.save}
      </Button>
      <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
        {fr.app.cancel}
      </Button>
    </form>
  );
}

/** Keyed by conversation in the parent: each conversation opens at its end. */
function MessageList({
  messages,
  stream,
  onRetry,
}: {
  messages: Message[];
  stream: StreamView | null;
  onRetry: (message: Message) => Promise<void>;
}) {
  const container = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLElement>(null);
  const stick = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const last = messages.at(-1);

  // Follow growing content (new messages, streamed text) only while the user has not scrolled up.
  useEffect(() => {
    const node = container.current;
    const inner = content.current;
    if (!node || !inner) return;
    const follow = () => {
      if (stick.current) node.scrollTop = node.scrollHeight;
    };
    follow();
    const observer = new ResizeObserver(follow);
    observer.observe(inner);
    return () => observer.disconnect();
  }, []);

  function onScroll() {
    const node = container.current;
    if (!node) return;
    const near = node.scrollHeight - node.scrollTop - node.clientHeight < STICK_THRESHOLD_PX;
    stick.current = near;
    setAtBottom(near);
  }

  return (
    <div className="nova-chat__scroll" ref={container} onScroll={onScroll}>
      <section ref={content} className="nova-chat__messages" aria-label={fr.chat.messagesLabel}>
        {messages.map((message) => (
          <MessageItem
            key={message.id}
            message={message}
            stream={stream?.messageId === message.id ? stream : null}
            canRetry={!stream && message.id === last?.id && message.role === "assistant"}
            onRetry={onRetry}
          />
        ))}
      </section>
      {!atBottom ? (
        <Button
          className="nova-chat__to-bottom"
          size="sm"
          variant="secondary"
          icon={<ChevronDownIcon size={14} />}
          onClick={() => {
            const node = container.current;
            if (!node) return;
            stick.current = true;
            setAtBottom(true);
            node.scrollTop = node.scrollHeight;
          }}
        >
          {fr.chat.scrollToBottom}
        </Button>
      ) : null}
    </div>
  );
}

export function ChatView({ contextToggle }: { contextToggle: { open: boolean; toggle: () => void } | null }) {
  const activeId = useApp((state) => state.activeId);
  const detail = useApp((state) => state.detail);
  const detailStatus = useApp((state) => state.detailStatus);
  const detailError = useApp((state) => state.detailError);
  const stream = useApp((state) => (state.activeId ? (state.streams[state.activeId] ?? null) : null));
  const modelId = useApp((state) => selectedModelId(state, state.activeId));
  const models = useApp((state) => state.catalog.data?.models);
  const openModelPicker = useApp((state) => state.openModelPicker);
  const openConversation = useApp((state) => state.openConversation);
  const goHome = useApp((state) => state.goHome);
  const stop = useApp((state) => state.stop);
  const retry = useApp((state) => state.retry);
  const guard = useSendGuard(modelId, "conversation");
  const draft = useSendMessage(activeId);
  const hasWorkspace = useApp((state) => state.workspace.current !== null);
  const picker = useMentionPicker(draft.text, draft.setText);
  const toast = useToast();

  const shown = detail && detail.conversation.id === activeId ? detail : null;
  const model = findModel(models, modelId);
  const title = shown?.conversation.title ?? fr.conversation.untitled;

  function stopActive() {
    if (!activeId) return;
    stop(activeId).catch((error: unknown) => toast.show(errorToast(error, fr.composer.stop)));
  }

  /** Settles when the retry request is answered, so its button stays disabled until then. */
  async function retryMessage(message: Message): Promise<void> {
    if (!activeId) return;
    try {
      await retry(activeId, message.id);
    } catch (error) {
      toast.show(errorToast(error, fr.chat.retry));
    }
  }

  let body;
  if (activeId && !shown && detailStatus === "error" && detailError) {
    const notFound = detailError.code === "not_found";
    body = (
      <div className="nova-chat__state">
        <Callout
          tone="danger"
          title={notFound ? fr.chat.notFound : fr.chat.loadFailed}
          action={
            <Button size="sm" variant="secondary" onClick={() => (notFound ? goHome() : openConversation(activeId))}>
              {notFound ? fr.chat.backHome : fr.app.retry}
            </Button>
          }
        >
          {notFound ? null : <p>{describeUiError(detailError).title}</p>}
        </Callout>
      </div>
    );
  } else if (activeId && !shown) {
    body = (
      <div className="nova-chat__state" aria-busy="true">
        <p className="nv-visually-hidden">{fr.chat.loading}</p>
        <Skeleton height={56} radius={12} />
        <Skeleton height={120} radius={12} />
      </div>
    );
  } else if (!shown || shown.messages.length === 0) {
    body = (
      <div className="nova-chat__state">
        <EmptyState title={fr.chat.emptyTitle} description={fr.chat.emptyBody} headingLevel={2} />
      </div>
    );
  } else {
    body = <MessageList key={activeId} messages={shown.messages} stream={stream} onRetry={retryMessage} />;
  }

  return (
    <div className="nova-chat">
      <header className="nova-chat__header">
        {shown ? (
          <TitleEditor key={shown.conversation.id} id={shown.conversation.id} title={title} />
        ) : (
          <h1 className="nova-chat__title">{title}</h1>
        )}
        <div className="nova-chat__tools">
          <Button size="sm" variant="secondary" onClick={() => openModelPicker("conversation")}>
            {modelId ? fr.chat.modelButton(model?.name ?? modelId) : fr.chat.chooseModel}
          </Button>
          {contextToggle ? (
            <IconButton
              aria-label={fr.chat.contextToggle}
              aria-expanded={contextToggle.open}
              icon={<PanelRightIcon />}
              size="sm"
              onClick={contextToggle.toggle}
            />
          ) : null}
        </div>
      </header>
      {body}
      {/* Capture phase: the mention picker takes ↑ ↓ Entrée Échap only while it is open. */}
      <div className="nova-chat__composer" onKeyDownCapture={hasWorkspace ? picker.onKeyDownCapture : undefined}>
        {draft.error ? <SendFailure error={draft.error} /> : null}
        {hasWorkspace ? <MentionPicker picker={picker} /> : null}
        <Composer
          key={activeId ?? "new"}
          label={fr.composer.label}
          streaming={stream !== null}
          blocked={guard}
          value={draft.text}
          onValueChange={draft.setText}
          onSend={draft.send}
          onStop={stopActive}
          autoFocus
        />
        {hasWorkspace ? <ContextInspector goal={draft.text} onGoalChange={draft.setText} target="chat" /> : null}
      </div>
    </div>
  );
}
