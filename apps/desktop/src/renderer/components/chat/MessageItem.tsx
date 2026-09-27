import { memo } from "react";
import { Button, Callout, OrbitIndicator } from "@nova/ui";
import type { Message, ProviderErrorInfo } from "@nova/shared";
import { fr } from "../../copy/fr";
import { describeProviderError } from "../../lib/errors";
import { formatCost, formatTokens } from "../../lib/format";
import { useNow } from "../../lib/hooks";
import type { StreamView } from "../../state/chat-reducer";
import { useErrorAction } from "../useErrorAction";
import { Markdown } from "./Markdown";

export interface MessageItemProps {
  message: Message;
  /** The live stream of this message, when it is being generated. */
  stream: StreamView | null;
  /** Only the last answer of a conversation can be regenerated, and never during a generation. */
  canRetry: boolean;
  onRetry: (message: Message) => void;
}

function UsageFooter({ message }: { message: Message }) {
  const { usage, servedModel, servedProvider } = message;
  const parts: string[] = [];
  if (usage) {
    parts.push(fr.chat.usageIn(formatTokens(usage.promptTokens) ?? fr.app.unknown));
    parts.push(fr.chat.usageOut(formatTokens(usage.completionTokens) ?? fr.app.unknown));
    const cost = formatCost(usage.cost);
    parts.push(cost ? fr.chat.costKnown(cost) : fr.chat.costUnknown);
  } else {
    parts.push(fr.chat.usageUnknown);
  }
  if (servedModel) parts.push(fr.chat.servedBy(servedModel));
  if (servedProvider) parts.push(fr.chat.via(servedProvider));
  return <p className="nova-message__usage">{parts.join(" · ")}</p>;
}

function secondsLeft(message: Message, error: ProviderErrorInfo, now: number): number {
  if (error.code !== "rate_limited" || error.retryAfterSec === null) return 0;
  return Math.max(0, Math.ceil((message.updatedAt + error.retryAfterSec * 1000 - now) / 1000));
}

function ErrorBlock({ message, error, canRetry, onRetry }: MessageItemProps & { error: ProviderErrorInfo }) {
  const now = useNow(1000);
  const action = useErrorAction(error.code);
  const wait = secondsLeft(message, error, now);
  // The countdown replaces the provider's Retry-After in the title and reaches the plain title at 0.
  const copy = describeProviderError({ ...error, retryAfterSec: wait > 0 ? wait : null });
  const { title } = copy;
  const retryLabel = wait > 0 ? fr.chat.retryIn(wait) : fr.chat.retry;
  return (
    // No role="alert": opening a conversation must not re-announce its old errors; new failures are
    // announced once by the app's outcome announcer.
    <Callout
      tone="danger"
      role="note"
      title={title}
      action={
        canRetry || action ? (
          <div className="nova-message__actions">
            {canRetry ? (
              <Button size="sm" variant="secondary" disabled={wait > 0} onClick={() => onRetry(message)}>
                {retryLabel}
              </Button>
            ) : null}
            {action ? (
              <Button size="sm" variant="ghost" onClick={action.run}>
                {action.label}
              </Button>
            ) : null}
          </div>
        ) : undefined
      }
    >
      <p>{copy.detail}</p>
      {error.providerMessage || error.httpStatus !== null ? (
        <details className="nova-message__details">
          <summary>{fr.chat.providerDetail}</summary>
          <p>
            {error.httpStatus !== null ? `${fr.chat.httpStatus(error.httpStatus)} ` : null}
            {error.providerMessage}
          </p>
        </details>
      ) : null}
    </Callout>
  );
}

function AssistantBody({ message, stream, canRetry, onRetry }: MessageItemProps) {
  if (message.status === "streaming") {
    const phase = stream?.phase ?? "waiting";
    if (message.content.length === 0) {
      return (
        <p className="nova-message__pending">
          <OrbitIndicator active size={16} />
          <span>{phase === "reasoning" ? fr.chat.reasoning : fr.chat.thinking}</span>
        </p>
      );
    }
    return (
      <>
        <Markdown text={message.content} />
        <OrbitIndicator active size={14} className="nova-message__cursor" />
      </>
    );
  }
  const retry = canRetry ? (
    <Button size="sm" variant="secondary" onClick={() => onRetry(message)}>
      {message.status === "stopped" ? fr.chat.relaunch : fr.chat.retry}
    </Button>
  ) : null;
  return (
    <>
      {message.content.length > 0 ? <Markdown text={message.content} /> : null}
      {message.status === "stopped" ? (
        <div className="nova-message__note">
          <span>{fr.chat.stopped}</span>
          {retry}
        </div>
      ) : null}
      {message.status === "interrupted" ? (
        <Callout tone="warning" title={fr.chat.interrupted} action={retry ?? undefined} />
      ) : null}
      {message.status === "error" ? (
        <ErrorBlock
          message={message}
          stream={stream}
          canRetry={canRetry}
          onRetry={onRetry}
          error={message.error ?? { code: "unknown", httpStatus: null, retryAfterSec: null, providerMessage: null, retryable: false }}
        />
      ) : null}
      <UsageFooter message={message} />
    </>
  );
}

export const MessageItem = memo(function MessageItem(props: MessageItemProps) {
  const { message } = props;
  const isUser = message.role === "user";
  return (
    <article className={`nova-message nova-message--${message.role}`} aria-label={isUser ? fr.chat.you : fr.chat.nomi}>
      <p className="nova-message__author" aria-hidden>
        {isUser ? fr.chat.you : fr.chat.nomi}
      </p>
      <div className="nova-message__body">
        {isUser ? <p className="nova-message__text">{message.content}</p> : <AssistantBody {...props} />}
      </div>
    </article>
  );
});
