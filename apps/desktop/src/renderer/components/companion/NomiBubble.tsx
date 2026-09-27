// Nomi's bubble: one fact + at most two actions (NOMI.md §4). Shows, in this order, the outcome of
// the last action (every click ends here), a dropped file's intents, or the visible suggestion
// with its evidence. The live region is always mounted so screen readers hear each new fact.
import { NOMI_COPY, type ActionOutcome, type ChangeLine, type DropIntent, type ModelExplainPlan } from "@nova/companion";
import type { CompanionSignal, CompanionSuggestion } from "@nova/shared";
import { Button } from "@nova/ui";

export interface NomiBubbleDrop {
  name: string;
  size: string;
  intents: DropIntent[];
  onIntent(intent: DropIntent): void;
  onCancel(): void;
}

export interface NomiBubbleProps {
  outcome: ActionOutcome | null;
  suggestion: CompanionSuggestion | null;
  /** The signal justifying `suggestion` (its evidence is shown with it). */
  signal: CompanionSignal | null;
  drop: NomiBubbleDrop | null;
  /** Level 2 of « Explique cette erreur »: what would be sent and its cost; null = no model. */
  askModel: { plan: ModelExplainPlan; onAsk(): void } | null;
  busy: boolean;
  onRespond(response: "accept" | "snooze" | "mute_kind"): void;
  onOpenLine(line: ChangeLine): void;
  onDismiss(): void;
}

function OutcomeView({ outcome, askModel, busy, onOpenLine, onDismiss }: Pick<NomiBubbleProps, "askModel" | "busy" | "onOpenLine" | "onDismiss"> & { outcome: ActionOutcome }) {
  const explanation = outcome.ok ? outcome.explanation : undefined;
  const lines = outcome.ok ? outcome.lines : undefined;
  return (
    <div className={outcome.ok ? "nova-nomi-bubble" : "nova-nomi-bubble nova-nomi-bubble--failed"} data-kind="outcome">
      <p className="nova-nomi-bubble__text">{outcome.message}</p>
      {explanation ? (
        <dl className="nova-nomi-bubble__explain">
          <dt>{NOMI_COPY.explain.title}</dt>
          <dd>{explanation.what}</dd>
          {explanation.why ? (
            <>
              <dt>{NOMI_COPY.explain.why}</dt>
              <dd>{explanation.why}</dd>
            </>
          ) : null}
          <dt>{NOMI_COPY.explain.next}</dt>
          <dd>{explanation.next}</dd>
        </dl>
      ) : null}
      {explanation?.evidence ? <pre className="nova-nomi-bubble__evidence">{explanation.evidence}</pre> : null}
      {lines && lines.length > 0 ? (
        <ul className="nova-nomi-bubble__lines">
          {lines.map((line) => (
            <li key={line.text}>
              {line.target ? (
                <button type="button" className="nova-nomi-bubble__link" onClick={() => onOpenLine(line)}>
                  {line.text}
                </button>
              ) : (
                line.text
              )}
            </li>
          ))}
        </ul>
      ) : null}
      {explanation && askModel ? (
        <div className="nova-nomi-bubble__ask">
          <p>{askModel.plan.disclosure}</p>
          <p>{askModel.plan.costLabel}</p>
          <Button size="sm" variant="secondary" disabled={busy} onClick={askModel.onAsk}>
            {NOMI_COPY.explain.askModel}
          </Button>
        </div>
      ) : null}
      <div className="nova-nomi-bubble__actions">
        <Button size="sm" variant="ghost" onClick={onDismiss}>
          {NOMI_COPY.bubble.close}
        </Button>
      </div>
    </div>
  );
}

export function NomiBubble(props: NomiBubbleProps) {
  const { outcome, suggestion, signal, drop, busy, onRespond } = props;
  let content = null;
  if (outcome) {
    content = <OutcomeView outcome={outcome} askModel={props.askModel} busy={busy} onOpenLine={props.onOpenLine} onDismiss={props.onDismiss} />;
  } else if (drop) {
    content = (
      <div className="nova-nomi-bubble" data-kind="drop">
        <p className="nova-nomi-bubble__text">{drop.size ? `${drop.name} · ${drop.size}` : drop.name}</p>
        {drop.intents.map((intent) =>
          intent.kind === "refused" ? (
            <p key={intent.reason}>{intent.reason}</p>
          ) : (
            <div key={intent.kind} className="nova-nomi-bubble__intent">
              {intent.kind === "attach_text" ? <p>{intent.disclosure}</p> : null}
              {intent.kind === "choose_model" ? <p>{intent.reason}</p> : null}
              <Button size="sm" variant="secondary" onClick={() => drop.onIntent(intent)}>
                {intent.label}
              </Button>
            </div>
          ),
        )}
        <div className="nova-nomi-bubble__actions">
          <Button size="sm" variant="ghost" onClick={drop.onCancel}>
            {NOMI_COPY.drop.cancel}
          </Button>
        </div>
      </div>
    );
  } else if (suggestion) {
    content = (
      <div className="nova-nomi-bubble" data-kind="suggestion">
        <p className="nova-nomi-bubble__text">{suggestion.text}</p>
        {signal?.evidence.excerpt ? (
          <details className="nova-nomi-bubble__proof">
            <summary>{NOMI_COPY.suggestion.evidence}</summary>
            {signal.evidence.path ? <p>{signal.evidence.path}</p> : null}
            <pre className="nova-nomi-bubble__evidence">{signal.evidence.excerpt}</pre>
          </details>
        ) : null}
        <div className="nova-nomi-bubble__actions">
          <Button size="sm" variant="primary" disabled={busy} onClick={() => onRespond("accept")}>
            {NOMI_COPY.suggestion.look}
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => onRespond("snooze")}>
            {NOMI_COPY.suggestion.later}
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => onRespond("mute_kind")}>
            {NOMI_COPY.suggestion.muteKind}
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div className="nova-nomi-bubble-region" role="status" aria-live="polite" aria-label={NOMI_COPY.bubble.region}>
      {content}
    </div>
  );
}
