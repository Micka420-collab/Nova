// "Mission terminée" card (UX.md minute 8, §5.1 step 8; VISUAL.md §4.4 success state): counts,
// Vérifié / Non vérifié (only what an event proves), estimated vs observed cost, review entry.
import { Button, Callout, StatusPill, type BadgeTone } from "@nova/ui";
import { fr } from "../../copy/fr";
import { ACCEPTANCE_LABELS, FAILURE_REASON_COPY, TASK_STATE_LABELS } from "../../copy/fr-atelier";
import { formatCost, formatInteger } from "../../lib/format";
import { useApp } from "../../state/context";
import { missionFacts, type MissionFacts, type MissionOutcome, type MissionView } from "../missions/timeline";
import { formatEstimate } from "./ContractSheet";

const copy = fr.atelier.end;

export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes === 0) return `${rest} s`;
  return rest === 0 ? `${minutes} min` : `${minutes} min ${rest} s`;
}

const TONES: Record<MissionOutcome["type"], BadgeTone> = { succeeded: "jade", failed: "danger", cancelled: "neutral" };

/** Observed cost line: exact, "au moins" when a call had no reported cost, else unknown. */
export function observedCostLine(view: MissionView): string {
  const budget = view.budget;
  if (!budget) return fr.context.costUnknown;
  const spent = formatCost(budget.spentUsd) ?? fr.app.unknown;
  return budget.unknownCostCalls > 0 ? copy.costAtLeast(spent, budget.unknownCostCalls) : copy.costObserved(spent);
}

/** Unknown stays unknown: searches without a reported cost make the sum a lower bound, or unknown. */
function webCostLine(facts: MissionFacts) {
  if (facts.webSearchCostUsd > 0) {
    return <span>{copy.webCost(formatCost(facts.webSearchCostUsd) ?? "", facts.webSearchesWithoutCost > 0)}</span>;
  }
  return facts.webSearchesWithoutCost > 0 ? <span>{copy.webCostUnknown}</span> : null;
}

export function EndCard({ view }: { view: MissionView }) {
  const estimate = useApp((state) => state.missions.estimates[view.mission.id] ?? null);
  const openDoc = useApp((state) => state.openDoc);
  const outcome = view.outcome;
  if (!outcome) return null;
  const facts = missionFacts(view);
  const title = outcome.type === "succeeded" ? copy.succeeded : outcome.type === "failed" ? copy.failed : copy.cancelled;
  const elapsed = view.mission.startedAt !== null ? formatElapsed(outcome.at - view.mission.startedAt) : null;
  const estimateText = estimate ? formatEstimate(estimate) : null;
  const changed = facts.files.length > 0;

  return (
    <section className={`nova-endcard nova-endcard--${outcome.type}`} aria-labelledby={`end-${view.mission.id}`}>
      <header className="nova-endcard__header">
        <h3 id={`end-${view.mission.id}`} className="nova-endcard__title">
          {title}
        </h3>
        <StatusPill tone={TONES[outcome.type]}>
          {outcome.type === "cancelled" ? copy.cancelledBy[outcome.by] : title}
        </StatusPill>
        {elapsed ? <span className="nova-endcard__meta">{elapsed}</span> : null}
      </header>
      {outcome.type === "succeeded" && outcome.summary ? <p className="nova-endcard__summary">{outcome.summary}</p> : null}
      {outcome.type === "failed" ? (
        <Callout tone="danger" title={FAILURE_REASON_COPY[outcome.reason]}>
          {outcome.detail ? <p>{outcome.detail}</p> : null}
        </Callout>
      ) : null}
      <p className="nova-endcard__counts">
        {changed ? copy.counts(facts.created, facts.modified, facts.deleted, facts.moved) : copy.noChanges}
        {facts.commands > 0 ? ` · ${copy.commands(facts.commands)}` : ""}
      </p>
      <div className="nova-endcard__proofs">
        <div>
          <h4 className="nova-endcard__subtitle">{copy.verified}</h4>
          {facts.verified.length > 0 ? (
            <ul>
              {facts.verified.map((task) => (
                <li key={task.id}>
                  {task.title}
                  {task.acceptance.detail ? <code className="nova-endcard__detail">{task.acceptance.detail}</code> : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="nova-note">{copy.verifiedNone}</p>
          )}
        </div>
        <div>
          <h4 className="nova-endcard__subtitle">{copy.unverified}</h4>
          {facts.unverified.length > 0 ? (
            <ul>
              {facts.unverified.map((task) => (
                <li key={task.id}>
                  {task.title} ·{" "}
                  <span className="nova-note">
                    {task.acceptance.kind === "manual" ? copy.manual : `${ACCEPTANCE_LABELS[task.acceptance.kind]} (${TASK_STATE_LABELS[task.state]})`}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="nova-note">{copy.unverifiedNone}</p>
          )}
        </div>
      </div>
      <dl className="nova-endcard__cost" aria-label={copy.reportTitle}>
        <dt>{copy.reportTitle}</dt>
        <dd>
          <span>{observedCostLine(view)}</span>
          <span>{estimateText ? copy.costEstimate(estimateText) : copy.costUnknownEstimate}</span>
          {facts.tokensIn + facts.tokensOut > 0 ? (
            <span>{copy.tokens(formatInteger(facts.tokensIn), formatInteger(facts.tokensOut), facts.messagesWithoutUsage > 0)}</span>
          ) : null}
          {webCostLine(facts)}
          {facts.approvalsAsked > 0 ? <span>{copy.approvals(facts.approvalsAsked, facts.approvalsDenied)}</span> : null}
        </dd>
      </dl>
      <p className="nova-note">{copy.billingNote}</p>
      {changed ? (
        <div className="nova-endcard__actions">
          <Button variant="primary" size="sm" onClick={() => openDoc({ kind: "diff", missionId: view.mission.id })}>
            {copy.review}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
