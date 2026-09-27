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

/** Served model and provider of the latest answer that reported them. */
function lastServed(detail: ConversationDetail): { model: string | null; provider: string | null } {
  for (let index = detail.messages.length - 1; index >= 0; index -= 1) {
    const message = detail.messages[index];
    if (message?.role === "assistant" && (message.servedModel || message.servedProvider)) {
      return { model: message.servedModel, provider: message.servedProvider };
    }
  }
  return { model: null, provider: null };
}

/** Something was reported, or an answer may have been billed without a reported cost. */
function hasConsumption({ usage }: ConversationDetail): boolean {
  return usage.promptTokens + usage.completionTokens > 0 || usage.cost > 0 || usage.messagesWithUnknownCost > 0;
}

export function ContextPanel() {
  const activeId = useApp((state) => (state.ui.route === "chat" ? state.activeId : null));
  const detail = useApp((state) => (state.detail && state.detail.conversation.id === state.activeId ? state.detail : null));
  const modelId = useApp((state) => selectedModelId(state, state.activeId));
  const catalog = useApp((state) => state.catalog.data);
  const privacy = useApp((state) => state.settings?.privacy.providerDataCollection ?? null);
  const openSettings = useApp((state) => state.openSettings);
  const now = useNow(30_000);
  const shown = activeId ? detail : null;
  const model = findModel(catalog?.models, modelId);
  const served = shown ? lastServed(shown) : null;

  return (
    <div className="nova-context">
      <h2 className="nova-context__title">{fr.context.title}</h2>
      {shown ? (
        <dl className="nova-facts">
          <dt>{fr.context.requestedModel}</dt>
          <dd>
            {model?.name ?? modelId ?? fr.models.noneSelected}
            {modelId ? <code className="nova-context__id">{modelId}</code> : null}
          </dd>
          <dt>{fr.context.servedModel}</dt>
          <dd>{served?.model ?? fr.app.unknown}</dd>
          <dt>{fr.context.servedProvider}</dt>
          <dd>{served?.provider ?? fr.app.unknown}</dd>
          <dt>{fr.context.destination}</dt>
          <dd>{fr.context.destinationValue(served?.provider ?? fr.context.providerUnknown)}</dd>
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
