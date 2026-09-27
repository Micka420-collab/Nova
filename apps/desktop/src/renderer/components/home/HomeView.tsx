import { useState } from "react";
import { Button, Callout } from "@nova/ui";
import type { ProviderConnectionView } from "@nova/shared";
import { fr } from "../../copy/fr";
import { formatRelative } from "../../lib/format";
import { useNow } from "../../lib/hooks";
import { useApp } from "../../state/context";
import { selectedModelId } from "../../state/store";
import { Composer } from "../chat/Composer";
import { useSendGuard } from "../chat/useSendGuard";
import { SendFailure } from "../chat/SendFailure";
import { useSendMessage } from "../chat/useSendMessage";
import { findModel } from "../models/filter";
import { Onboarding } from "../setup/Onboarding";

const RECENT_COUNT = 5;

export function HomeView() {
  const connection = useApp((state) => state.connection);
  const vaultLevel = useApp((state) => state.appInfo?.vault.level ?? null);
  const modelId = useApp((state) => selectedModelId(state, null));
  const models = useApp((state) => state.catalog.data?.models);
  const conversations = useApp((state) => state.conversations);
  const query = useApp((state) => state.query);
  const openConversation = useApp((state) => state.openConversation);
  const openModelPicker = useApp((state) => state.openModelPicker);
  const openSettings = useApp((state) => state.openSettings);
  const [saved, setSaved] = useState<ProviderConnectionView | null>(null);
  const guard = useSendGuard(modelId, "new");
  const draft = useSendMessage(null);
  const now = useNow(60_000);

  if (connection?.state === "absent" || saved) {
    return <Onboarding saved={saved} onSaved={setSaved} onDone={() => setSaved(null)} />;
  }

  const model = findModel(models, modelId);
  // The sidebar search filters the shared list; recents only make sense unfiltered.
  const recent = query.trim() === "" ? conversations.slice(0, RECENT_COUNT) : [];
  return (
    <div className="nova-home">
      <header className="nova-home__header">
        <h1 className="nova-home__title">{fr.home.title}</h1>
        <p className="nova-lead">{fr.home.subtitle}</p>
      </header>

      {connection?.state === "invalid" ? (
        <Callout
          tone="danger"
          title={fr.composer.invalidKey}
          action={
            <Button size="sm" variant="secondary" onClick={() => openSettings("providers")}>
              {fr.providers.replace}
            </Button>
          }
        />
      ) : null}
      {vaultLevel === "weak" ? <Callout tone="warning">{fr.home.vaultWeak}</Callout> : null}
      {vaultLevel === "unavailable" ? <Callout tone="warning">{fr.home.vaultUnavailable}</Callout> : null}

      <section className="nova-card" aria-labelledby="home-new-idea">
        <div className="nova-card__header">
          <h2 id="home-new-idea" className="nova-card__title">
            {fr.home.newIdea}
          </h2>
          {modelId ? (
            <Button size="sm" variant="ghost" onClick={() => openModelPicker("new")}>
              {fr.home.currentModel(model?.name ?? modelId)} · {fr.home.changeModel}
            </Button>
          ) : null}
        </div>
        {!modelId ? (
          <Callout
            tone="info"
            title={fr.home.chooseModelTitle}
            action={
              <Button size="sm" variant="primary" onClick={() => openModelPicker("new")}>
                {fr.home.chooseModelAction}
              </Button>
            }
          >
            <p>{fr.home.chooseModelBody}</p>
          </Callout>
        ) : null}
        {draft.error ? <SendFailure error={draft.error} /> : null}
        <Composer
          label={fr.home.newIdeaLabel}
          placeholder={fr.home.newIdeaPlaceholder}
          streaming={false}
          blocked={guard}
          value={draft.text}
          onValueChange={draft.setText}
          onSend={draft.send}
          onStop={() => undefined}
          autoFocus
        />
      </section>

      {recent.length > 0 ? (
        <section className="nova-card" aria-labelledby="home-resume">
          <h2 id="home-resume" className="nova-card__title">
            {fr.home.resume}
          </h2>
          <ul className="nova-recent">
            {recent.map((item) => (
              <li key={item.id}>
                <button type="button" className="nova-recent__item" onClick={() => openConversation(item.id)}>
                  <span className="nova-recent__title">{item.title}</span>
                  {item.preview ? <span className="nova-recent__preview">{item.preview}</span> : null}
                  <span className="nova-recent__time">{formatRelative(item.updatedAt, now)}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <Callout tone="info" className="nova-home__note">
        {fr.home.milestoneNote}
      </Callout>
    </div>
  );
}
