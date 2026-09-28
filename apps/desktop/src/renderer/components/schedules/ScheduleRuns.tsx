// Run history of one schedule (L6): every due time with its outcome and reason (missed, overlap,
// budget, start failure), newest first, and « Ouvrir la mission » for runs that started one.
// Pushed runs update the rows live (`schedule.run`).
import { useCallback, useEffect, useState } from "react";
import { useStore } from "zustand";
import { Button, Callout, StatusPill } from "@nova/ui";
import type { NovaApi, Schedule, ScheduleRun } from "@nova/shared";
import { schedulesCopy } from "../../copy/fr-schedules";
import type { SchedulesStore } from "../../state/schedules-slice";
import { describeRun, formatInstant, runTone } from "./schedule-format";

const copy = schedulesCopy.runs;
/** Rows loaded at once (the history keeps SCHEDULE_LIMITS.historyMax per schedule). */
const RUNS_SHOWN = 50;
const EMPTY: readonly ScheduleRun[] = [];

export interface ScheduleRunsProps {
  api: Pick<NovaApi["schedules"], "runs">;
  store: SchedulesStore;
  schedule: Schedule;
  onOpenMission?(missionId: string): void;
}

export function ScheduleRuns({ api, store, schedule, onOpenMission }: ScheduleRunsProps) {
  const runs = useStore(store, (state) => state.runs[schedule.id] ?? EMPTY);
  const loaded = useStore(store, (state) => state.runs[schedule.id] !== undefined);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  const load = useCallback(() => {
    api.runs({ scheduleId: schedule.id, limit: RUNS_SHOWN }).then(
      (list) => {
        store.getState().setRuns(schedule.id, list);
        setStatus("ready");
      },
      () => setStatus("error"),
    );
  }, [api, store, schedule.id]);

  useEffect(load, [load]);

  return (
    <section className="nova-sched-runs" aria-label={`${copy.title} — ${schedule.title}`}>
      <h3 className="nova-sched-form__legend">{copy.title}</h3>
      {status === "loading" && !loaded ? <p className="nova-note">{copy.loading}</p> : null}
      {status === "error" ? (
        <Callout tone="danger" action={
            <Button
              onClick={() => {
                setStatus("loading");
                load();
              }}
            >
              {schedulesCopy.retry}
            </Button>
          }>
          {copy.failed}
        </Callout>
      ) : null}
      {status === "ready" && runs.length === 0 ? <p className="nova-note">{copy.empty}</p> : null}
      {runs.length > 0 ? (
        <ol className="nova-sched-runs__list">
          {runs.map((run) => {
            const missionId = run.missionId;
            return (
              <li key={run.id} className="nova-sched-runs__item">
                <StatusPill tone={runTone(run)} active={run.outcome === "running"}>
                  {describeRun(run)}
                </StatusPill>
                <span className="nova-sched__meta">{copy.due(formatInstant(run.dueAt))}</span>
                {missionId !== null && onOpenMission ? (
                  <Button size="sm" variant="ghost" onClick={() => onOpenMission(missionId)}>
                    {copy.openMission}
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ol>
      ) : null}
    </section>
  );
}
