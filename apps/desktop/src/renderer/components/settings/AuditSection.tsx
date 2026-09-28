// Réglages › Journal d'audit (S5): what the agent was allowed, refused, asked and did, as main
// recorded it (`audit.list`), newest first. Filters by actor, decision, operation and period run
// in main; the text filter runs on the loaded rows. Targets are paths, hosts or redacted commands:
// the log never holds file or page content.
import { useId, useState } from "react";
import { Button, Callout, TextField } from "@nova/ui";
import { OPERATION_CLASSES, type AuditActor, type AuditEntry, type OperationClass, type PermissionDecisionKind } from "@nova/shared";
import { fr } from "../../copy/fr";
import { OPERATION_LABELS } from "../../copy/fr-atelier";
import { formatCost, formatInteger } from "../../lib/format";
import { useApp, useClient } from "../../state/context";
import { formatDateTime, SectionError, SectionLoading, useLoaded } from "./section-states";

const copy = fr.atelierSettings.audit;
const PAGE = 200;
const DAY_MS = 24 * 60 * 60_000;
const PERIODS = { all: null, day: DAY_MS, week: 7 * DAY_MS, month: 30 * DAY_MS } as const;
type Period = keyof typeof PERIODS;

export interface AuditFilters {
  actor: AuditActor | "all";
  decision: PermissionDecisionKind | "all";
  operation: OperationClass | "all";
  period: Period;
  text: string;
}

const INITIAL_FILTERS: AuditFilters = { actor: "all", decision: "all", operation: "all", period: "all", text: "" };

/** Rows whose tool, target, action or outcome contains the text (case-insensitive). Exported for tests. */
export function filterEntries(entries: readonly AuditEntry[], text: string): AuditEntry[] {
  const needle = text.trim().toLowerCase();
  if (!needle) return [...entries];
  return entries.filter((entry) =>
    [entry.target, entry.action, entry.outcome, typeof entry.dataSummary?.["tool"] === "string" ? entry.dataSummary["tool"] : null].some(
      (value) => value?.toLowerCase().includes(needle),
    ),
  );
}

/** Sizes, exit code, duration: facts only, unknown ones left out. Exported for tests. */
export function entryFacts(entry: AuditEntry): string[] {
  const summary = entry.dataSummary ?? {};
  const facts: string[] = [];
  const number = (key: string): number | null => (typeof summary[key] === "number" ? summary[key] : null);
  const sent = number("bytesSent");
  const received = number("bytesReceived");
  const written = number("bytesWritten");
  const exitCode = number("exitCode");
  const durationMs = number("durationMs");
  if (sent !== null) facts.push(copy.bytesSent(formatInteger(sent)));
  if (received !== null) facts.push(copy.bytesReceived(formatInteger(received)));
  if (written !== null) facts.push(copy.bytesWritten(formatInteger(written)));
  if (exitCode !== null) facts.push(copy.exitCode(exitCode));
  if (durationMs !== null) facts.push(copy.duration(formatInteger(Math.round(durationMs))));
  return facts;
}

function actionLabel(action: string): string {
  return (copy.actions as Record<string, string>)[action] ?? action;
}

function Filters({ filters, onChange }: { filters: AuditFilters; onChange: (next: AuditFilters) => void }) {
  const id = useId();
  const select = <K extends keyof AuditFilters>(key: K, label: string, options: readonly [AuditFilters[K], string][]) => (
    <label className="nv-field" htmlFor={`${id}-${key}`}>
      <span className="nv-field__label">{label}</span>
      <select
        id={`${id}-${key}`}
        className="nv-field__control nova-aset-select"
        value={String(filters[key])}
        onChange={(event) => onChange({ ...filters, [key]: event.target.value as AuditFilters[K] })}
      >
        {options.map(([value, text]) => (
          <option key={String(value)} value={String(value)}>
            {text}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <div className="nova-aset-filters">
      {select("period", copy.filterPeriod, [
        ["all", copy.all],
        ["day", copy.periods.day],
        ["week", copy.periods.week],
        ["month", copy.periods.month],
      ])}
      {select("actor", copy.filterActor, [
        ["all", copy.all],
        ["agent", copy.actors.agent],
        ["user", copy.actors.user],
        ["system", copy.actors.system],
      ])}
      {select("decision", copy.filterDecision, [
        ["all", copy.all],
        ["allow", copy.decisions.allow],
        ["ask", copy.decisions.ask],
        ["deny", copy.decisions.deny],
      ])}
      {select("operation", copy.filterOperation, [
        ["all", copy.all],
        ...OPERATION_CLASSES.map((operation): [OperationClass, string] => [operation, OPERATION_LABELS[operation]]),
      ])}
      <TextField
        label={copy.filterText}
        type="search"
        value={filters.text}
        onChange={(event) => onChange({ ...filters, text: event.target.value })}
      />
    </div>
  );
}

function EntriesTable({ entries }: { entries: AuditEntry[] }) {
  return (
    <div className="nova-aset-table-wrap">
      <table className="nova-aset-table">
        <caption className="nv-visually-hidden">{copy.title}</caption>
        <thead>
          <tr>
            <th scope="col">{copy.colTime}</th>
            <th scope="col">{copy.colActor}</th>
            <th scope="col">{copy.colAction}</th>
            <th scope="col">{copy.colTarget}</th>
            <th scope="col">{copy.colStatus}</th>
            <th scope="col">{copy.colDetails}</th>
            <th scope="col">{copy.colCost}</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => {
            const tool = entry.dataSummary?.["tool"];
            const facts = entryFacts(entry);
            return (
              <tr key={entry.seq} data-decision={entry.decision ?? undefined}>
                <td>{formatDateTime(entry.at)}</td>
                <td>{copy.actors[entry.actor]}</td>
                <td>
                  {actionLabel(entry.action)}
                  {typeof tool === "string" ? (
                    <>
                      {" "}
                      <code>{tool}</code>
                    </>
                  ) : null}
                </td>
                <td>{entry.target ? <code className="nova-aset-target">{entry.target}</code> : "—"}</td>
                <td>{entry.decision ? copy.decisions[entry.decision] : "—"}</td>
                <td>
                  {entry.outcome ?? ""}
                  {facts.length > 0 ? <span className="nova-note"> {facts.join(" · ")}</span> : null}
                </td>
                <td>{entry.costUsd === null ? "—" : (formatCost(entry.costUsd) ?? fr.app.unknown)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function AuditSection() {
  const client = useClient();
  const workspaceId = useApp((state) => state.workspace.current?.id ?? null);
  const [filters, setFilters] = useState<AuditFilters>(INITIAL_FILTERS);
  const [older, setOlder] = useState<{ key: string; entries: AuditEntry[]; done: boolean }>({ key: "", entries: [], done: false });
  const [loadingMore, setLoadingMore] = useState(false);
  const { actor, decision, operation, period } = filters;
  const key = `${workspaceId ?? "all"}|${actor}|${decision}|${operation}|${period}`;

  const query = (beforeSeq: number | null) => {
    const span = PERIODS[period];
    return client.audit.list({
      workspaceId,
      missionId: null,
      actor: actor === "all" ? null : actor,
      action: null,
      decision: decision === "all" ? null : decision,
      operation: operation === "all" ? null : operation,
      since: span === null ? null : Date.now() - span,
      until: null,
      beforeSeq,
      limit: PAGE,
    });
  };
  const [loaded, retry] = useLoaded<AuditEntry[]>(key, () => query(null));
  const more = older.key === key ? older : { key, entries: [], done: false };

  async function loadMore(all: AuditEntry[]) {
    const last = all.at(-1);
    if (!last) return;
    setLoadingMore(true);
    try {
      const page = await query(last.seq);
      setOlder({ key, entries: [...more.entries, ...page], done: page.length < PAGE });
    } catch {
      setOlder({ ...more, done: true });
    } finally {
      setLoadingMore(false);
    }
  }

  const all = loaded.status === "ready" ? [...loaded.data, ...more.entries] : [];
  const shown = filterEntries(all, filters.text);
  const canLoadMore = loaded.status === "ready" && loaded.data.length === PAGE && !more.done;

  return (
    <div className="nova-aset">
      <Callout tone="info">{copy.intro}</Callout>
      <Filters filters={filters} onChange={setFilters} />
      {loaded.status === "loading" ? <SectionLoading /> : null}
      {loaded.status === "error" ? <SectionError error={loaded.error} onRetry={retry} /> : null}
      {loaded.status === "ready" ? (
        <>
          {all.length > 0 ? (
            <p className="nova-note" aria-live="polite">
              {copy.count(shown.length, all.length)}
            </p>
          ) : null}
          {all.length === 0 ? <p className="nova-aset-empty">{copy.empty}</p> : null}
          {all.length > 0 && shown.length === 0 ? <p className="nova-aset-empty">{copy.filteredEmpty}</p> : null}
          {shown.length > 0 ? <EntriesTable entries={shown} /> : null}
          {canLoadMore ? (
            <div className="nova-actions">
              <Button size="sm" variant="secondary" loading={loadingMore} onClick={() => void loadMore(all)}>
                {copy.loadMore}
              </Button>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
