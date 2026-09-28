// Detail density controls (J2-B L7): the radio list of the onboarding and the settings, and the
// compact switch of a mission card with what the density hides. Density is display only.
import { useId } from "react";
import { Button, SegmentedControl, useToast } from "@nova/ui";
import { DETAIL_DENSITIES, type DetailDensity } from "@nova/shared";
import { DENSITY_DESCRIPTIONS, DENSITY_LABELS, desktopCopy } from "../../copy/fr-desktop";
import { errorToast } from "../../lib/errors";
import { useApp } from "../../state/context";
import { applyDensity, type DensityView } from "../missions/density";
import type { TimelineItem } from "../missions/timeline";
// oxlint-disable-next-line import/no-unassigned-import -- component styles (Vite injects them)
import "./onboarding.css";

export const DEFAULT_DENSITY: DetailDensity = "key_steps";

export function DensityChoice({
  value,
  onChange,
  legend = desktopCopy.density.legend,
}: {
  value: DetailDensity;
  onChange: (density: DetailDensity) => void;
  legend?: string;
}) {
  const name = useId();
  return (
    <fieldset className="nova-choices">
      <legend className="nv-field__label">{legend}</legend>
      {DETAIL_DENSITIES.map((density) => (
        <label key={density} className="nova-choice">
          <input type="radio" name={name} value={density} checked={value === density} onChange={() => onChange(density)} />
          <span className="nova-choice__label">{DENSITY_LABELS[density]}</span>
          <span className="nova-choice__hint">{DENSITY_DESCRIPTIONS[density]}</span>
        </label>
      ))}
    </fieldset>
  );
}

/** The saved density and its setter (a failed save is shown, the density stays as it was). */
export function useDensitySetting(): { density: DetailDensity; setDensity: (density: DetailDensity) => Promise<void> } {
  const density = useApp((state) => state.settings?.display.density ?? DEFAULT_DENSITY);
  const updateSettings = useApp((state) => state.updateSettings);
  const toast = useToast();
  return {
    density,
    setDensity: async (next) => {
      if (next === density) return;
      try {
        await updateSettings({ display: { density: next } });
      } catch (error) {
        toast.show(errorToast(error, desktopCopy.density.failed));
      }
    },
  };
}

export interface MissionDensity extends DensityView {
  density: DetailDensity;
  setDensity: (density: DetailDensity) => Promise<void>;
}

/** The timeline items a mission card shows at the saved density (to pass to `groupTimeline`). */
export function useMissionDensity(items: readonly TimelineItem[]): MissionDensity {
  const { density, setDensity } = useDensitySetting();
  return { ...applyDensity(items, density), density, setDensity };
}

/** Density switch of a mission card, and what it hides with a way to see everything. */
export function MissionDensityBar({ control }: { control: MissionDensity }) {
  const options = DETAIL_DENSITIES.map((density) => ({ value: density, label: DENSITY_LABELS[density] }));
  return (
    <div className="nova-density-bar">
      <SegmentedControl
        label={desktopCopy.density.legend}
        size="sm"
        options={options}
        value={control.density}
        onChange={(density) => void control.setDensity(density)}
      />
      {control.hidden > 0 ? (
        <p className="nova-density-bar__hidden">
          <span>{desktopCopy.density.hidden(control.hidden, DENSITY_LABELS[control.density])}</span>
          <Button size="sm" variant="ghost" onClick={() => void control.setDensity("all")}>
            {desktopCopy.density.showAll}
          </Button>
        </p>
      ) : null}
    </div>
  );
}
