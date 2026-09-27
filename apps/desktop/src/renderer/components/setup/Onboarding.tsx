import { Button, Lockup, useToast } from "@nova/ui";
import type { ModelInfo, ProviderConnectionView } from "@nova/shared";
import { fr } from "../../copy/fr";
import { errorToast } from "../../lib/errors";
import { useApp } from "../../state/context";
import { ModelBrowser } from "../models/ModelBrowser";
import { ConnectionOutcome, KeySetup } from "./KeySetup";

export interface OnboardingProps {
  /** Connection returned by the key step; null while the key step is shown. */
  saved: ProviderConnectionView | null;
  onSaved: (connection: ProviderConnectionView) => void;
  onDone: () => void;
}

/** First launch: key first, then a model. Shown whenever no key is configured. */
export function Onboarding({ saved, onSaved, onDone }: OnboardingProps) {
  const chooseModel = useApp((state) => state.chooseModel);
  const defaultModelId = useApp((state) => state.settings?.defaultModelId ?? null);
  const toast = useToast();

  async function select(model: ModelInfo) {
    try {
      await chooseModel(model.id, "default");
      onDone();
    } catch (error) {
      toast.show(errorToast(error, fr.settings.saveFailed));
    }
  }

  return (
    <section className="nova-onboarding" aria-labelledby="onboarding-title">
      <Lockup height={28} className="nova-onboarding__logo" />
      <p className="nova-eyebrow">{fr.onboarding.eyebrow}</p>
      <h1 id="onboarding-title" className="nova-onboarding__title">
        {saved ? fr.home.chooseModelTitle : fr.onboarding.title}
      </h1>
      {saved ? (
        <>
          <ConnectionOutcome connection={saved} />
          <p className="nova-lead">{fr.home.chooseModelBody}</p>
          <ModelBrowser selectedId={defaultModelId} onSelect={(model) => void select(model)} preferQuickAuthor />
          <div className="nova-actions">
            <Button variant="ghost" onClick={onDone}>
              {fr.app.close}
            </Button>
          </div>
        </>
      ) : (
        <>
          <p className="nova-lead">{fr.onboarding.body}</p>
          <KeySetup onSaved={onSaved} />
        </>
      )}
    </section>
  );
}
