// L8 — search in the journal of the missions (FTS in main; excerpts redacted there). The scope
// is this mission, this project or every project; each hit says which mission, which event and
// when, and opens it. Nothing renders while main does not serve `timeline.*`.
import { useState, type FormEvent } from "react";
import { Button, Callout, SegmentedControl, TextField } from "@nova/ui";
import type { TimelineHit } from "@nova/shared";
import { EVENT_TYPE_LABELS, timelineCopy } from "../../copy/fr-timeline";
import { describeUiError } from "../../lib/errors";
import { formatRelative } from "../../lib/format";
import { TIMELINE_SEARCH_LIMIT, type TimelineScope } from "../../state/timeline-slice";
import { useTimelineAvailable, useTimelineSlice, useTimelineStore } from "./use-timeline-store";
// oxlint-disable-next-line import/no-unassigned-import
import "./timeline.css";

const copy = timelineCopy.search;

export interface TimelineSearchProps {
  /** Current project; null = only « Tous les projets ». */
  workspaceId: string | null;
  /** Mission shown next to the search; null = no « Cette mission » scope. */
  missionId: string | null;
  /** Opens the mission of a hit (and scrolls to its event when it can). */
  onOpen(hit: TimelineHit): void;
  now?: () => number;
}

export function TimelineSearch({ workspaceId, missionId, onOpen, now = Date.now }: TimelineSearchProps) {
  const available = useTimelineAvailable();
  const store = useTimelineStore();
  const search = useTimelineSlice((state) => state.search);
  const [text, setText] = useState(search.query);
  if (!available) return null;

  const scopes: { value: TimelineScope; label: string; disabled: boolean }[] = [
    { value: "mission", label: copy.scopeMission, disabled: missionId === null },
    { value: "workspace", label: copy.scopeWorkspace, disabled: workspaceId === null },
    { value: "all", label: copy.scopeAll, disabled: false },
  ];
  const scope = scopes.find((option) => option.value === search.scope && !option.disabled)?.value ?? (workspaceId ? "workspace" : "all");

  const run = (nextScope: TimelineScope): void => {
    void store.getState().runSearch({ query: text, scope: nextScope, workspaceId, missionId });
  };
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    run(scope);
  };

  return (
    <section className="nova-timeline-search" aria-label={copy.region}>
      <form className="nova-timeline-search__form" onSubmit={submit}>
        <div className="nova-timeline-search__row">
          <TextField label={copy.label} placeholder={copy.placeholder} value={text} maxLength={200} onChange={(event) => setText(event.target.value)} />
          <Button type="submit" variant="primary" loading={search.status === "searching"} disabled={!text.trim()}>
            {copy.submit}
          </Button>
        </div>
        <SegmentedControl
          label={copy.scope}
          options={scopes}
          value={scope}
          onChange={(next) => {
            store.getState().setScope(next);
            if (text.trim()) run(next);
          }}
        />
      </form>
      <SearchOutcome now={now} onOpen={onOpen} />
    </section>
  );
}

function SearchOutcome({ onOpen, now }: { onOpen(hit: TimelineHit): void; now: () => number }) {
  const search = useTimelineSlice((state) => state.search);
  if (search.status === "idle") return <p className="nova-note">{copy.hint}</p>;
  if (search.status === "searching") return <output className="nova-timeline-search__status">{copy.searching}</output>;
  if (search.status === "error") {
    const error = search.error ? describeUiError(search.error) : null;
    return (
      <Callout tone="danger" title={copy.failed}>
        {error?.title}
      </Callout>
    );
  }
  if (search.hits.length === 0) return <output className="nova-timeline-search__status">{copy.empty(search.query)}</output>;
  const at = now();
  return (
    <>
      <output className="nova-timeline-search__status">
        {copy.results(search.hits.length)}
        {search.hits.length >= TIMELINE_SEARCH_LIMIT ? ` · ${copy.capped(TIMELINE_SEARCH_LIMIT)}` : ""}
      </output>
      <ul className="nova-timeline-hits" aria-label={copy.results(search.hits.length)}>
        {search.hits.map((hit) => (
          <li key={`${hit.missionId}:${hit.seq}`} className="nova-timeline-hit">
            <div className="nova-timeline-hit__head">
              <p className="nova-timeline-hit__title">{hit.missionTitle}</p>
              <span className="nova-timeline-hit__meta">
                {EVENT_TYPE_LABELS[hit.type] ?? timelineCopy.eventFallback} · {copy.event(hit.seq)} · {formatRelative(hit.at, at)}
              </span>
            </div>
            <p className="nova-timeline-hit__snippet">{hit.snippet}</p>
            <div>
              <Button size="sm" onClick={() => onOpen(hit)} aria-label={`${copy.open} : ${hit.missionTitle}, ${copy.event(hit.seq)}`}>
                {copy.open}
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}
