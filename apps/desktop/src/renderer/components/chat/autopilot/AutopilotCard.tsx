// The autopilot's choice for the message about to leave: effort and web, why, who estimated it and
// what it cost; both can be changed before sending. The fallback is labeled as such.
import { Button, OrbitIndicator, SegmentedControl, Switch } from "@nova/ui";
import { REASONING_EFFORTS } from "@nova/shared";
import { EFFORT_LABELS, desktopCopy } from "../../../copy/fr-desktop";
import { formatCost } from "../../../lib/format";
import type { AutopilotControl } from "./useAutopilot";
// oxlint-disable-next-line import/no-unassigned-import -- component styles (Vite injects them)
import "./autopilot.css";

export interface AutopilotCardProps {
  control: AutopilotControl;
  /** « Envoyer avec ces réglages » (same as Enter). */
  onSend: () => void;
  /** Sends the message as if the autopilot were off. */
  onSendWithout: () => void;
  /** Re-estimates for the current text. */
  onReclassify: () => void;
  busy: boolean;
}

export function AutopilotCard({ control, onSend, onSendWithout, onReclassify, busy }: AutopilotCardProps) {
  const { phase } = control;
  const copy = desktopCopy.autopilot;
  if (phase.kind === "idle") return null;
  if (phase.kind === "classifying") {
    return (
      <output className="nova-autopilot nova-autopilot--busy">
        <OrbitIndicator active size={14} />
        <span>{copy.classifying}</span>
      </output>
    );
  }
  if (phase.kind === "failed") {
    return (
      <div className="nova-autopilot" role="alert">
        <p className="nova-autopilot__text">{phase.unavailable ? copy.unavailable : copy.failed}</p>
        <div className="nova-autopilot__actions">
          {phase.unavailable ? null : (
            <Button size="sm" variant="secondary" onClick={onReclassify}>
              {copy.reclassify}
            </Button>
          )}
          <Button size="sm" variant="ghost" loading={busy} onClick={onSendWithout}>
            {copy.sendWithout}
          </Button>
        </div>
      </div>
    );
  }
  const { choice } = phase;
  const fallback = choice.source === "fallback";
  const cost = formatCost(choice.costUsd);
  const provenance = [
    choice.classifierModelId ? copy.by(choice.classifierModelId) : null,
    cost === null ? copy.costUnknown : copy.cost(cost),
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");
  const effortOptions = REASONING_EFFORTS.map((effort) => ({ value: effort, label: EFFORT_LABELS[effort] }));
  return (
    <section className="nova-autopilot" aria-label={fallback ? copy.fallbackTitle : copy.title}>
      <p className="nova-autopilot__title">{fallback ? copy.fallbackTitle : copy.title}</p>
      <p className="nova-autopilot__text">{choice.rationale}</p>
      <div className="nova-autopilot__controls">
        {phase.reasoningEffort === null ? (
          <p className="nova-autopilot__text">
            {copy.effort} : {copy.effortNotApplicable}
          </p>
        ) : (
          <SegmentedControl
            label={copy.effort}
            size="sm"
            options={effortOptions}
            value={phase.reasoningEffort}
            onChange={(value) => control.dispatch({ type: "effort", value })}
          />
        )}
        <Switch label={copy.web} checked={phase.webSearch} onCheckedChange={(value) => control.dispatch({ type: "web", value })} />
      </div>
      <p className="nova-autopilot__meta">{provenance}</p>
      <div className="nova-autopilot__actions">
        <Button size="sm" variant="primary" loading={busy} onClick={onSend}>
          {copy.send}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={onReclassify}>
          {copy.reclassify}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={control.reset}>
          {copy.dismiss}
        </Button>
      </div>
    </section>
  );
}
