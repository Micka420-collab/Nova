// L2 (A15) — the handoff dossier the next model starts from, as NOVA built it from its journal.
import type { HandoffDossier } from "@nova/shared";
import { contextCopy } from "../../copy/fr-context";
import { fr } from "../../copy/fr";
// Side-effect import: the stylesheet ships with the component (emitted as a file, CSP-safe).
// oxlint-disable-next-line import/no-unassigned-import
import "./context.css";

const copy = contextCopy.handoff;

function Section({ title, items }: { title: string; items: readonly string[] }) {
  return (
    <section className="nova-context-card__section">
      <h4>{title}</h4>
      {items.length === 0 ? (
        <p className="nova-note">{copy.empty}</p>
      ) : (
        <ul className="nova-context-card__list">
          {items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function HandoffCard({ dossier, switched }: { dossier: HandoffDossier; switched: boolean }) {
  const from = dossier.fromModelId ?? fr.app.unknown;
  return (
    <article className="nova-context-card" aria-label={copy.title(from, dossier.toModelId)}>
      <header className="nova-context-card__head">
        <h3 className="nova-context-card__title">{copy.title(from, dossier.toModelId)}</h3>
      </header>
      <p className="nova-note">{switched ? copy.switched(from, dossier.toModelId) : copy.pending}</p>
      <Section title={copy.goal} items={[dossier.goal]} />
      <Section title={copy.done} items={dossier.done} />
      <Section title={copy.remaining} items={dossier.remaining} />
      <Section title={copy.decisions} items={dossier.decisions} />
      <Section title={copy.files} items={dossier.filesTouched} />
      <Section title={copy.questions} items={dossier.openQuestions} />
    </article>
  );
}
