// Scheduled missions (L6, Pr5): the list of a project's schedules with their state, next and last
// run, pause / resume, edit, history and removal, plus the editor. Records come from main
// (`schedules.list` + `onEvent`); a group that answers `unavailable` (not wired) shows nothing at
// all (no inert control). Every action ends in a visible outcome: the new state (announced), the
// history, or an error in the row.
import { useCallback, useEffect, useState } from "react";
import { useStore } from "zustand";
import { Button, Callout, EmptyState, StatusPill } from "@nova/ui";
import { NovaIpcError, type NovaApi, type Schedule } from "@nova/shared";
import { scheduleErrorCopy, schedulesCopy } from "../../copy/fr-schedules";
import type { SchedulesStore } from "../../state/schedules-slice";
import { ScheduleEditor, type ScheduleModelChoice } from "./ScheduleEditor";
import { ScheduleRuns } from "./ScheduleRuns";
import { describeTrigger, formatInstant } from "./schedule-format";
import { localTimeZone, type ScheduleFields } from "./schedule-form";
// Side-effect import: the manager's stylesheet ships with the component (emitted as a file, CSP-safe).
// oxlint-disable-next-line import/no-unassigned-import
import "./schedules.css";

const copy = schedulesCopy;

export type SchedulesApi = Pick<NovaApi["schedules"], "list" | "create" | "update" | "setPaused" | "remove" | "runs" | "onEvent">;

export interface SchedulesManagerProps {
  api: SchedulesApi;
  store: SchedulesStore;
  /** The project whose schedules are shown (a schedule belongs to one project). */
  workspaceId: string;
  /** Catalog models (tool-less ones are not offered). */
  models: readonly ScheduleModelChoice[];
  defaultModelId: string | null;
  /** Opens a run's mission; absent = no « Ouvrir la mission » button. */
  onOpenMission?(missionId: string): void;
  now?: () => number;
}

function codeOf(error: unknown): NovaIpcError["code"] | null {
  return error instanceof NovaIpcError ? error.code : null;
}

const STATE_TONE = { active: "jade", paused: "amber", completed: "neutral" } as const;

type Editing = { kind: "none" } | { kind: "new" } | { kind: "edit"; scheduleId: string };

export function SchedulesManager({ api, store, workspaceId, models, defaultModelId, onOpenMission, now = Date.now }: SchedulesManagerProps) {
  const all = useStore(store, (state) => state.schedules);
  const status = useStore(store, (state) => state.status);
  const [editing, setEditing] = useState<Editing>({ kind: "none" });
  const [busy, setBusy] = useState<Record<string, true>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [history, setHistory] = useState<Record<string, true>>({});
  const [confirming, setConfirming] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const zone = localTimeZone();
  const schedules = all.filter((item) => item.workspaceId === workspaceId);

  const load = useCallback(() => {
    store.getState().setStatus("loading");
    api.list({ workspaceId }).then(
      (list) => {
        const others = store.getState().schedules.filter((item) => item.workspaceId !== workspaceId);
        store.getState().setSchedules([...others, ...list]);
        store.getState().setStatus("ready");
      },
      (error: unknown) => store.getState().setStatus(codeOf(error) === "unavailable" ? "unavailable" : "error"),
    );
  }, [api, store, workspaceId]);

  useEffect(load, [load]);
  useEffect(() => api.onEvent((event) => store.getState().applyEvent(event)), [api, store]);

  if (status === "unavailable" || status === "idle") return null;

  const setError = (scheduleId: string, message: string | null): void =>
    setErrors(({ [scheduleId]: _dropped, ...rest }) => (message === null ? rest : { ...rest, [scheduleId]: message }));
  const setBusyFor = (scheduleId: string, value: boolean): void =>
    setBusy(({ [scheduleId]: _dropped, ...rest }) => (value ? { ...rest, [scheduleId]: true } : rest));

  const act = async (schedule: Schedule, action: () => Promise<void>): Promise<void> => {
    setError(schedule.id, null);
    setBusyFor(schedule.id, true);
    try {
      await action();
    } catch (error) {
      setError(schedule.id, scheduleErrorCopy(codeOf(error)));
    } finally {
      setBusyFor(schedule.id, false);
    }
  };

  const togglePause = (schedule: Schedule) =>
    act(schedule, async () => {
      const paused = schedule.state !== "paused";
      store.getState().upsert(await api.setPaused({ scheduleId: schedule.id, paused }));
      setAnnouncement(paused ? copy.pausedAnnouncement(schedule.title) : copy.resumedAnnouncement(schedule.title));
    });

  const remove = (schedule: Schedule) =>
    act(schedule, async () => {
      await api.remove({ scheduleId: schedule.id });
      store.getState().applyEvent({ type: "schedule.removed", scheduleId: schedule.id });
      setConfirming(null);
      setAnnouncement(copy.removedAnnouncement(schedule.title));
    });

  const save = async (fields: ScheduleFields): Promise<void> => {
    const saved =
      editing.kind === "edit" ? await api.update({ scheduleId: editing.scheduleId, patch: fields }) : await api.create({ workspaceId, ...fields });
    store.getState().upsert(saved);
    setEditing({ kind: "none" });
    setAnnouncement(copy.savedAnnouncement(saved.title));
  };

  const edited = editing.kind === "edit" ? (schedules.find((item) => item.id === editing.scheduleId) ?? null) : null;

  return (
    <section className="nova-sched" aria-labelledby="nova-sched-title">
      <header className="nova-sched__header">
        <h1 id="nova-sched-title" className="nova-sched__title">
          {copy.title}
        </h1>
        {editing.kind === "none" && status === "ready" ? (
          <Button variant="primary" onClick={() => setEditing({ kind: "new" })}>
            {copy.create}
          </Button>
        ) : null}
      </header>
      <p className="nova-note">{copy.intro}</p>
      <Callout tone="info" role="note">
        {copy.onlyWhileOpen}
      </Callout>
      <output className="nv-visually-hidden" aria-live="polite">
        {announcement}
      </output>

      {editing.kind !== "none" ? (
        <ScheduleEditor
          key={editing.kind === "edit" ? editing.scheduleId : "new"}
          schedule={edited}
          models={models}
          defaultModelId={defaultModelId}
          save={save}
          onCancel={() => setEditing({ kind: "none" })}
          now={now}
        />
      ) : null}

      {status === "loading" ? <p className="nova-note">{copy.loading}</p> : null}
      {status === "error" ? (
        <Callout tone="danger" action={<Button onClick={load}>{copy.retry}</Button>}>
          {copy.loadFailed}
        </Callout>
      ) : null}
      {status === "ready" && schedules.length === 0 && editing.kind === "none" ? <EmptyState title={copy.empty} description={copy.emptyHint} headingLevel={2} /> : null}

      {schedules.length > 0 ? (
        <ul className="nova-sched__list" aria-label={copy.list}>
          {schedules.map((schedule) => {
            const title = schedule.title;
            const isBusy = busy[schedule.id] === true;
            return (
              <li key={schedule.id} className="nova-sched__item">
                <div className="nova-sched__row">
                  <strong className="nova-sched__name">{title}</strong>
                  <StatusPill tone={STATE_TONE[schedule.state]}>{copy.state[schedule.state]}</StatusPill>
                </div>
                <p className="nova-sched__meta">{describeTrigger(schedule.trigger, zone)}</p>
                <p className="nova-sched__meta">
                  {schedule.nextRunAt !== null ? copy.next(formatInstant(schedule.nextRunAt)) : copy.noNext}
                  {" · "}
                  {schedule.lastRunAt !== null ? copy.last(formatInstant(schedule.lastRunAt)) : copy.neverRan}
                </p>
                <div className="nova-sched__actions">
                  {schedule.state !== "completed" ? (
                    <Button
                      size="sm"
                      loading={isBusy}
                      aria-label={schedule.state === "paused" ? copy.resumeLabel(title) : copy.pauseLabel(title)}
                      title={schedule.state === "paused" ? undefined : copy.pauseNote}
                      onClick={() => void togglePause(schedule)}
                    >
                      {schedule.state === "paused" ? copy.resume : copy.pause}
                    </Button>
                  ) : null}
                  <Button size="sm" variant="ghost" aria-label={copy.editLabel(title)} onClick={() => setEditing({ kind: "edit", scheduleId: schedule.id })}>
                    {copy.edit}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-expanded={history[schedule.id] === true}
                    aria-label={copy.historyLabel(title)}
                    onClick={() =>
                      setHistory(({ [schedule.id]: shown, ...rest }) => {
                        if (shown) store.getState().forgetRuns(schedule.id);
                        return shown ? rest : { ...rest, [schedule.id]: true };
                      })
                    }
                  >
                    {history[schedule.id] ? copy.hideHistory : copy.history}
                  </Button>
                  <Button size="sm" variant="ghost" aria-label={copy.removeLabel(title)} onClick={() => setConfirming(schedule.id)}>
                    {copy.remove}
                  </Button>
                </div>
                {confirming === schedule.id ? (
                  <div className="nova-sched__confirm">
                    <p>{copy.removeConfirm(title)}</p>
                    <Button size="sm" variant="danger" loading={isBusy} onClick={() => void remove(schedule)}>
                      {copy.removeYes}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setConfirming(null)}>
                      {copy.removeNo}
                    </Button>
                  </div>
                ) : null}
                {errors[schedule.id] ? (
                  <p className="nova-sched__error" role="alert">
                    {errors[schedule.id]}
                  </p>
                ) : null}
                {history[schedule.id] ? <ScheduleRuns api={api} store={store} schedule={schedule} {...(onOpenMission ? { onOpenMission } : {})} /> : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
