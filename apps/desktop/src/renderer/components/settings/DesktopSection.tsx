// Settings › Bureau et affichage (J2-B L7): keep running in the background (explained where it is
// turned on), the detail density of mission cards, and the Discuter helpers (autopilot, vision
// suggestion). Controls that need main (background, autopilot) appear only once main serves the
// desktop group; while it answers `unavailable` they are not shown.
import { Switch, useToast } from "@nova/ui";
import type { SettingsPatch } from "@nova/shared";
import { desktopCopy } from "../../copy/fr-desktop";
import { errorToast } from "../../lib/errors";
import { useApp } from "../../state/context";
import { useDesktopSlice } from "../../state/desktop-slice";
import { DensityChoice, useDensitySetting } from "../onboarding/DensityChoice";

function useSaveSetting(): (patch: SettingsPatch) => Promise<void> {
  const updateSettings = useApp((state) => state.updateSettings);
  const toast = useToast();
  return async (patch) => {
    try {
      await updateSettings(patch);
    } catch (error) {
      toast.show(errorToast(error, desktopCopy.settings.failed));
    }
  };
}

export function DesktopSection() {
  const settings = useApp((state) => state.settings);
  const availability = useDesktopSlice((state) => state.availability);
  const desktop = useDesktopSlice((state) => state.state);
  const autopilotUnavailable = useDesktopSlice((state) => state.autopilotUnavailable);
  const { density, setDensity } = useDensitySetting();
  const save = useSaveSetting();
  if (!settings) return null;
  const copy = desktopCopy.settings;
  const wired = availability === "available";
  return (
    <>
      {wired ? (
        <section className="nova-setting" aria-labelledby="settings-desktop-background">
          <h3 id="settings-desktop-background" className="nova-subheading">
            {copy.backgroundTitle}
          </h3>
          <Switch
            label={copy.keepRunning}
            description={copy.keepRunningHelp}
            checked={settings.desktop.keepRunningOnClose}
            onCheckedChange={(keepRunningOnClose) => void save({ desktop: { keepRunningOnClose } })}
          />
          {desktop && !desktop.trayAvailable ? <p className="nova-note">{copy.noTray}</p> : null}
          <p className="nova-note">{copy.quitNote}</p>
          {desktop ? (
            <p className="nova-note">
              {copy.activity(desktop.activity.runningMissions, desktop.activity.waitingApprovals, desktop.activity.runningProcesses)}
            </p>
          ) : null}
        </section>
      ) : null}
      <section className="nova-setting" aria-labelledby="settings-desktop-density">
        <h3 id="settings-desktop-density" className="nova-subheading">
          {copy.densityTitle}
        </h3>
        <DensityChoice value={density} onChange={(next) => void setDensity(next)} />
      </section>
      <section className="nova-setting" aria-labelledby="settings-desktop-chat">
        <h3 id="settings-desktop-chat" className="nova-subheading">
          {copy.chatTitle}
        </h3>
        {wired && !autopilotUnavailable ? (
          <Switch
            label={copy.autopilot}
            description={copy.autopilotHelp}
            checked={settings.chat.autopilot}
            onCheckedChange={(autopilot) => void save({ chat: { autopilot } })}
          />
        ) : null}
        <Switch
          label={copy.suggestVision}
          description={copy.suggestVisionHelp}
          checked={settings.chat.suggestVisionModel}
          onCheckedChange={(suggestVisionModel) => void save({ chat: { suggestVisionModel } })}
        />
      </section>
    </>
  );
}
