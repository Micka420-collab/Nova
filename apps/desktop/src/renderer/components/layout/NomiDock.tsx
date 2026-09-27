import { Nomi, StatusPill, type BadgeTone, type NomiState } from "@nova/ui";
import { fr } from "../../copy/fr";
import { REDUCED_MOTION_QUERY, useMediaQuery, useNow, useOnline } from "../../lib/hooks";
import { useApp } from "../../state/context";
import { deriveNomiState } from "../../state/nomi";
import { companionPhase } from "../../state/store";

const PILL_TONES: Record<NomiState, BadgeTone> = {
  offline: "neutral",
  idle: "jade",
  listening: "jade",
  thinking: "jade",
  working: "jade",
  waiting: "amber",
  speaking: "jade",
  success: "jade",
  error: "danger",
};

/** Companion status at the bottom of the navigation; a status pill replaces Nomi when it is hidden. */
export function NomiDock() {
  const online = useOnline();
  const connection = useApp((state) => state.connection);
  const phase = useApp(companionPhase);
  const lastOutcome = useApp((state) => state.lastOutcome);
  const companion = useApp((state) => state.settings?.companion ?? null);
  const openSettings = useApp((state) => state.openSettings);
  const systemReduced = useMediaQuery(REDUCED_MOTION_QUERY);
  // One-second ticks let the success/error pose expire on time.
  const now = useNow(1000);
  const view = deriveNomiState({ online, connection, activeStreamPhase: phase, lastOutcome, now });
  const reduced = companion?.motion === "reduce" || (companion?.motion !== "full" && systemReduced);
  const busy = phase !== null;

  if (companion && !companion.visible) {
    return (
      <button type="button" className="nova-dock nova-dock--compact" onClick={() => openSettings("companion")}>
        <StatusPill tone={PILL_TONES[view.state]} active={busy}>
          {view.label}
        </StatusPill>
        <span className="nova-dock__detail">{view.detail}</span>
      </button>
    );
  }
  return (
    <button
      type="button"
      className="nova-dock"
      title={fr.nomi.openSettings}
      onClick={() => openSettings("companion")}
    >
      <span className="nova-dock__figure" aria-hidden>
        <Nomi state={view.state} size={44} motion={reduced ? "reduced" : "full"} />
      </span>
      <span className="nova-dock__text">
        <span className="nova-dock__label">{view.label}</span>
        <span className="nova-dock__detail">{view.detail}</span>
      </span>
    </button>
  );
}
