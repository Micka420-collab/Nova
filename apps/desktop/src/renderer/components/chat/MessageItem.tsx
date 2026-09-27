import { memo, useState } from "react";
import { Button, Callout, OrbitIndicator } from "@nova/ui";
import type { Message, ProviderErrorInfo } from "@nova/shared";
import { fr, NO_PROVIDER_PRIVACY_HINT } from "../../copy/fr";
import { describeProviderError, mentionsDataPolicy } from "../../lib/errors";
import { formatCost, formatTokens } from "../../lib/format";
import { useNow } from "../../lib/hooks";
import { useApp } from "../../state/context";
import type { StreamView } from "../../state/chat-reducer";
import { useErrorAction } from "../useErrorAction";
import { Markdown } from "./Markdown";

export interface MessageItemProps {
  message: Message;
  /** The live stream of this message, when it is being generated. */
  stream: StreamView | null;
  /** Only the last answer of a conversation can be regenerated, and never during a generation. */
  canRetry: boolean;
  /** Settles once the retry request is answered (success or reported failure). */
  onRetry: (message: Message) => Promise<void>;
}

/** Disabled from the click until the request settles: a double click never sends two retries. */
function RetryButton({
  message,
  onRetry,
  label,
  disabled = false,
}: {
  message: Message;
  onRetry: MessageItemProps["onRetry"];
  label: string;
  disabled?: boolean;
}) {
  const [pending, setPending] = useState(false);
  function run() {
    setPending(true);
    void onRetry(message).finally(() => setPending(false));
  }
  return (
    <Button size="sm" variant="secondary" disabled={disabled} loading={pending} onClick={run}>
      {label}
    </Button>
  );
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
  const dataCollection = useApp((state) => state.settings?.privacy.providerDataCollection ?? null);
  const openSettings = useApp((state) => state.openSettings);
  const privacyHint = mentionsDataPolicy(error, dataCollection);
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
        canRetry || action || privacyHint ? (
          <div className="nova-message__actions">
            {canRetry ? <RetryButton message={message} onRetry={onRetry} label={retryLabel} disabled={wait > 0} /> : null}
            {action ? (
              <Button size="sm" variant="ghost" onClick={action.run}>
                {action.label}
              </Button>
            ) : null}
            {privacyHint ? (
              <Button size="sm" variant="ghost" onClick={() => openSettings("privacy")}>
                {fr.chat.openPrivacy}
              </Button>
            ) : null}
          </div>
        ) : undefined
      }
    >
      <p>{copy.detail}</p>
      {privacyHint ? <p>{NO_PROVIDER_PRIVACY_HINT}</p> : null}
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
    <RetryButton
      message={message}
      onRetry={onRetry}
      label={message.status === "stopped" ? fr.chat.relaunch : fr.chat.retry}
    />
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
