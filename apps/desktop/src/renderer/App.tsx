import { useEffect } from "react";
import { Button, Callout, Lockup, OrbitIndicator } from "@nova/ui";
import { fr, PROVIDER_ERROR_COPY } from "./copy/fr";
import { describeProviderError, describeUiError } from "./lib/errors";
import { LIGHT_SCHEME_QUERY, useMediaQuery } from "./lib/hooks";
import { useApp, useAppStore } from "./state/context";
import { CommandPalette } from "./components/palette/CommandPalette";
import { GlobalKeymap } from "./components/palette/GlobalKeymap";
import { ModelPicker } from "./components/models/ModelPicker";
import { AtelierHost } from "./components/layout/AtelierHost";
import { Workshop } from "./components/layout/Workshop";
import { ProfileOnboardingGate } from "./components/onboarding/ProfileOnboarding";

/** data-theme / data-motion / data-density on <html>, as the design system expects. */
function useDocumentPreferences() {
  const theme = useApp((state) => state.settings?.theme ?? "system");
  const motion = useApp((state) => state.settings?.companion.motion ?? "system");
  // Créer is comfortable, Expert compact (VISUAL.md §2.7) until density is its own setting.
  const density = useApp((state) => (state.ui.displayMode === "expert" ? "compact" : "comfortable"));
  const prefersLight = useMediaQuery(LIGHT_SCHEME_QUERY);
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = theme === "system" ? (prefersLight ? "light" : "dark") : theme;
    // "system" leaves the attribute out so the OS reduced-motion setting applies.
    if (motion === "system") delete root.dataset.motion;
    else root.dataset.motion = motion;
    root.dataset.density = density;
  }, [theme, motion, density, prefersLight]);
}

/** Announces the end of generations (never individual tokens) to screen readers. */
function OutcomeAnnouncer() {
  const outcome = useApp((state) => state.lastOutcome);
  let message = "";
  if (outcome?.kind === "success") message = fr.chat.announceCompleted;
  else if (outcome?.kind === "stopped") message = fr.chat.announceStopped;
  else if (outcome?.kind === "error") {
    message = fr.chat.announceFailed((outcome.error ? describeProviderError(outcome.error) : PROVIDER_ERROR_COPY.unknown).title);
  }
  // A new node per outcome: the same message twice in a row is announced twice.
  return (
    <output className="nv-visually-hidden" aria-live="polite">
      {outcome ? <span key={outcome.at}>{message}</span> : null}
    </output>
  );
}

function Boot() {
  const boot = useApp((state) => state.boot);
  const loadCore = useApp((state) => state.loadCore);
  return (
    <div className="nova-boot">
      <Lockup height={32} />
      {boot.status === "error" && boot.error ? (
        <Callout
          tone="danger"
          title={fr.app.bootFailed}
          action={
            <Button variant="secondary" size="sm" onClick={() => void loadCore()}>
              {fr.app.retry}
            </Button>
          }
        >
          <p>{describeUiError(boot.error).title}</p>
        </Callout>
      ) : (
        <output className="nova-boot__status">
          <OrbitIndicator active size={16} />
          <span>{fr.app.booting}</span>
        </output>
      )}
    </div>
  );
}

export function App() {
  const store = useAppStore();
  const ready = useApp((state) => state.boot.status === "ready");
  useEffect(() => store.getState().start(), [store]);
  useDocumentPreferences();

  if (!ready) return <Boot />;
  return (
    <>
      <a
        className="nova-skip"
        href="#nova-main"
        onClick={(event) => {
          event.preventDefault();
          document.getElementById("nova-main")?.focus();
        }}
      >
        {fr.layout.skipToContent}
      </a>
      <AtelierHost>
        <Workshop />
        <GlobalKeymap />
        <CommandPalette />
      </AtelierHost>
      <ModelPicker />
      <ProfileOnboardingGate />
      <OutcomeAnnouncer />
    </>
  );
}
