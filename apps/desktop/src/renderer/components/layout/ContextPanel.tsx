import { Button } from "@nova/ui";
import type { ConversationDetail, UsageTotals } from "@nova/shared";
import { fr } from "../../copy/fr";
import { formatCost, formatInteger, formatRelative } from "../../lib/format";
import { useNow } from "../../lib/hooks";
import { useApp } from "../../state/context";
import { selectedModelId } from "../../state/store";
import { findModel } from "../models/filter";

function costLine(usage: UsageTotals): string {
  const cost = formatCost(usage.cost);
  if (usage.messagesWithUnknownCost === 0 && cost) return fr.context.costObserved(cost);
  if (usage.cost > 0 && cost) return fr.context.costAtLeast(cost, usage.messagesWithUnknownCost);
  return fr.context.costUnknown;
}

interface AnswerModels {
  /** Model NOVA requested for the answer below (null = not recorded). */
  requested: string | null;
  served: string | null;
  provider: string | null;
}

/**
 * Requested and served model of the same answer: the latest that reported a served model, else the
 * latest answer. The requested model is the one recorded on that answer, never a pending choice.
 */
function answerModels(detail: ConversationDetail): AnswerModels {
  const answers = detail.messages.filter((message) => message.role === "assistant");
  const answer = answers.findLast((message) => message.servedModel || message.servedProvider) ?? answers.at(-1);
  return {
    requested: answer?.modelId ?? detail.conversation.modelId,
    served: answer?.servedModel ?? null,
    provider: answer?.servedProvider ?? null,
  };
}

/** Something was reported, or an answer may have been billed without a reported cost. */
function hasConsumption({ usage }: ConversationDetail): boolean {
  return usage.promptTokens + usage.completionTokens > 0 || usage.cost > 0 || usage.messagesWithUnknownCost > 0;
}

export function ContextPanel() {
  const activeId = useApp((state) => (state.ui.route === "chat" ? state.activeId : null));
  const detail = useApp((state) => (state.detail && state.detail.conversation.id === state.activeId ? state.detail : null));
  const nextModelId = useApp((state) => selectedModelId(state, state.activeId));
  const catalog = useApp((state) => state.catalog.data);
  const privacy = useApp((state) => state.settings?.privacy.providerDataCollection ?? null);
  const openSettings = useApp((state) => state.openSettings);
  const now = useNow(30_000);
  const shown = activeId ? detail : null;
  const answer = shown ? answerModels(shown) : null;
  const requestedId = answer?.requested ?? null;
  const requested = findModel(catalog?.models, requestedId);
  // A model picked for the next message is not a request yet: shown apart, never as "demandé".
  const pendingId = nextModelId !== null && nextModelId !== requestedId ? nextModelId : null;
  const pending = findModel(catalog?.models, pendingId);

  return (
    <div className="nova-context">
      <h2 className="nova-context__title">{fr.context.title}</h2>
      {shown ? (
        <dl className="nova-facts">
          <dt>{fr.context.requestedModel}</dt>
          <dd>
            {requested?.name ?? requestedId ?? fr.app.unknown}
            {requestedId ? <code className="nova-context__id">{requestedId}</code> : null}
            {pendingId ? (
              <span className="nova-context__next">{fr.context.nextModel(pending?.name ?? pendingId)}</span>
            ) : null}
          </dd>
          <dt>{fr.context.servedModel}</dt>
          <dd>{answer?.served ?? fr.app.unknown}</dd>
          <dt>{fr.context.servedProvider}</dt>
          <dd>{answer?.provider ?? fr.app.unknown}</dd>
          <dt>{fr.context.destination}</dt>
          <dd>{fr.context.destinationValue(answer?.provider ?? fr.context.providerUnknown)}</dd>
          <dt>{fr.context.usage}</dt>
          <dd>
            {hasConsumption(shown) ? (
              <>
                <span>
                  {fr.context.tokens(formatInteger(shown.usage.promptTokens), formatInteger(shown.usage.completionTokens))}
                </span>
                <span>{costLine(shown.usage)}</span>
              </>
            ) : (
              fr.context.usageNone
            )}
          </dd>
        </dl>
      ) : (
        <p className="nova-context__empty">{fr.context.noConversation}</p>
      )}
      <dl className="nova-facts">
        <dt>{fr.context.privacy}</dt>
        <dd>
          {privacy === null ? fr.app.unknown : privacy === "deny" ? fr.context.privacyDeny : fr.context.privacyAllow}
          <Button size="sm" variant="ghost" onClick={() => openSettings("privacy")}>
            {fr.context.privacyLink}
          </Button>
        </dd>
        <dt>{fr.context.catalog}</dt>
        <dd>
          {catalog
            ? catalog.source === "cache"
              ? fr.models.cacheNotice(formatRelative(catalog.fetchedAt, now))
              : fr.models.freshness(formatRelative(catalog.fetchedAt, now))
            : fr.context.catalogUnknown}
        </dd>
      </dl>
    </div>
  );
}
