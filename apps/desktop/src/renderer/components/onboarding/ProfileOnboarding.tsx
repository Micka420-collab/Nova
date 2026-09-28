// First-run choices (J2-B L7): a usage profile (code / documents) and the detail density of
// mission cards. Shown once a key exists and until a profile is saved (`settings.onboarding`);
// « Plus tard » hides it for this session only. Both choices are display only.
import { useState } from "react";
import { Button, Callout, Dialog } from "@nova/ui";
import { ONBOARDING_PROFILES, type AppSettings, type DetailDensity, type OnboardingProfile, type ProviderConnectionView } from "@nova/shared";
import { PROFILE_DEFAULT_DENSITY, PROFILE_DESCRIPTIONS, PROFILE_LABELS, desktopCopy } from "../../copy/fr-desktop";
import { describeUiError, toUiError, type UiError } from "../../lib/errors";
import { useApp } from "../../state/context";
import { DEFAULT_DENSITY, DensityChoice } from "./DensityChoice";
// oxlint-disable-next-line import/no-unassigned-import -- component styles (Vite injects them)
import "./onboarding.css";

/** The profile question comes after the key step (a key exists), until a profile is saved. */
export function needsProfileOnboarding(settings: AppSettings | null, connection: ProviderConnectionView | null): boolean {
  if (!settings || settings.onboarding.profile !== null) return false;
  return connection !== null && connection.state !== "absent";
}

export function ProfileOnboarding({ onLater }: { onLater: () => void }) {
  const updateSettings = useApp((state) => state.updateSettings);
  const saved = useApp((state) => state.settings?.display.density ?? DEFAULT_DENSITY);
  const [profile, setProfile] = useState<OnboardingProfile | null>(null);
  const [density, setDensity] = useState<DetailDensity>(saved);
  const [densityTouched, setDensityTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<UiError | null>(null);
  const [missingProfile, setMissingProfile] = useState(false);

  function chooseProfile(next: OnboardingProfile) {
    setProfile(next);
    setMissingProfile(false);
    // The profile proposes a density until the user picks one.
    if (!densityTouched) setDensity(PROFILE_DEFAULT_DENSITY[next]);
  }

  async function submit() {
    if (!profile) {
      setMissingProfile(true);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await updateSettings({ onboarding: { profile, completedAt: Date.now() }, display: { density } });
    } catch (failure) {
      setError(toUiError(failure));
    } finally {
      setSaving(false);
    }
  }

  const copy = desktopCopy.onboarding;
  return (
    <Dialog
      open
      onClose={onLater}
      title={copy.title}
      description={copy.intro}
      closeLabel={copy.later}
      footer={
        <div className="nova-actions">
          <Button variant="ghost" onClick={onLater}>
            {copy.later}
          </Button>
          <Button variant="primary" loading={saving} onClick={() => void submit()}>
            {saving ? copy.saving : copy.submit}
          </Button>
        </div>
      }
    >
      <div className="nova-profile-onboarding">
        <fieldset className="nova-choices">
          <legend className="nv-field__label">{copy.profileLegend}</legend>
          {ONBOARDING_PROFILES.map((option) => (
            <label key={option} className="nova-choice">
              <input type="radio" name="nova-onboarding-profile" value={option} checked={profile === option} onChange={() => chooseProfile(option)} />
              <span className="nova-choice__label">{PROFILE_LABELS[option]}</span>
              <span className="nova-choice__hint">{PROFILE_DESCRIPTIONS[option]}</span>
            </label>
          ))}
        </fieldset>
        {missingProfile ? (
          <p className="nova-composer__reason" role="alert">
            {copy.needProfile}
          </p>
        ) : null}
        <DensityChoice
          legend={copy.densityLegend}
          value={density}
          onChange={(next) => {
            setDensity(next);
            setDensityTouched(true);
          }}
        />
        {error ? (
          <Callout tone="danger" title={copy.failed}>
            <p>{describeUiError(error).title}</p>
          </Callout>
        ) : null}
      </div>
    </Dialog>
  );
}

/** Mount once in the app: shows the profile question when it is due (see `needsProfileOnboarding`). */
export function ProfileOnboardingGate() {
  const settings = useApp((state) => state.settings);
  const connection = useApp((state) => state.connection);
  const [later, setLater] = useState(false);
  if (later || !needsProfileOnboarding(settings, connection)) return null;
  return <ProfileOnboarding onLater={() => setLater(true)} />;
}
