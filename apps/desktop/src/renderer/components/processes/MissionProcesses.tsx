// Background processes of one mission (L1): what runs, where, its state, its latest output, and
// « Arrêter » / « Voir le terminal ». Records come from main (`processes.list` + `onEvent`); a group
// that answers `unavailable` (not wired) shows nothing at all (no inert control). Every action ends
// in a visible outcome: the new state, the output, or an error in the row.
import { useCallback, useEffect, useState } from "react";
import { useStore } from "zustand";
import { Button, Callout, StatusPill } from "@nova/ui";
import { NovaIpcError, type MissionProcess, type NovaApi, type ProcessOutput } from "@nova/shared";
import { processErrorCopy, processesCopy } from "../../copy/fr-processes";
import { missionProcesses, type ProcessesStore } from "../../state/processes-slice";
// Side-effect import: the list's stylesheet ships with the component (emitted as a file, CSP-safe).
// oxlint-disable-next-line import/no-unassigned-import
import "./processes.css";

const copy = processesCopy.panel;
/** Characters of output shown in a row (the API caps at PROCESS_LIMITS.outputTailMaxChars). */
const OUTPUT_CHARS = 4_000;

export type ProcessesApi = Pick<NovaApi["processes"], "list" | "output" | "stop" | "onEvent">;

export interface MissionProcessesProps {
  api: ProcessesApi;
  store: ProcessesStore;
  missionId: string;
  /** Opens the dock on this agent session; absent = no « Voir le terminal » button. */
  onShowTerminal?(sessionId: string): void;
}

function codeOf(error: unknown): NovaIpcError["code"] | null {
  return error instanceof NovaIpcError ? error.code : null;
}

function statusOf(process: MissionProcess): { label: string; tone: "neutral" | "jade" | "danger" } {
  if (process.state === "running") return { label: copy.running, tone: "jade" };
  if (process.state === "stopped") return { label: copy.stopped, tone: "neutral" };
  if (process.state === "handed_over") return { label: copy.handedOver, tone: "neutral" };
  // Only a known non-zero code is a failure: an unobserved end (code null) is unknown, not red.
  return { label: copy.exited(process.exitCode), tone: process.exitCode !== null && process.exitCode !== 0 ? "danger" : "neutral" };
}

function commandOf(process: MissionProcess): string {
  return process.argv.join(" ");
}

type OutputState = { status: "loading" } | { status: "ready"; output: ProcessOutput } | { status: "error"; message: string };

export function MissionProcesses({ api, store, missionId, onShowTerminal }: MissionProcessesProps) {
  const all = useStore(store, (state) => state.processes);
  const status = useStore(store, (state) => state.status);
  const stopping = useStore(store, (state) => state.stopping);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [outputs, setOutputs] = useState<Record<string, OutputState>>({});
  const [announcement, setAnnouncement] = useState("");
  const processes = missionProcesses(all, missionId);

  const load = useCallback(() => {
    store.getState().setStatus("loading");
    api.list({ workspaceId: null, missionId }).then(
      (list) => {
        store.getState().setProcesses({ workspaceId: null, missionId }, list);
        store.getState().setStatus("ready");
      },
      (error: unknown) => store.getState().setStatus(codeOf(error) === "unavailable" ? "unavailable" : "error"),
    );
  }, [api, store, missionId]);

  useEffect(load, [load]);
  useEffect(() => api.onEvent((event) => store.getState().applyEvent(event)), [api, store]);

  const setError = (processId: string, message: string | null): void =>
    setErrors(({ [processId]: _dropped, ...rest }) => (message === null ? rest : { ...rest, [processId]: message }));

  const stop = async (process: MissionProcess): Promise<void> => {
    setError(process.id, null);
    store.getState().setStopping(process.id, true);
    try {
      const ended = await api.stop({ processId: process.id });
      store.getState().upsert(ended);
      setAnnouncement(copy.stoppedAnnouncement(commandOf(process)));
    } catch (error) {
      setError(process.id, processErrorCopy(codeOf(error)));
    } finally {
      store.getState().setStopping(process.id, false);
    }
  };

  const readOutput = async (processId: string): Promise<void> => {
    setOutputs((current) => ({ ...current, [processId]: { status: "loading" } }));
    try {
      const output = await api.output({ processId, maxChars: OUTPUT_CHARS });
      setOutputs((current) => ({ ...current, [processId]: { status: "ready", output } }));
    } catch (error) {
      setOutputs((current) => ({ ...current, [processId]: { status: "error", message: processErrorCopy(codeOf(error)) } }));
    }
  };

  const hideOutput = (processId: string): void => setOutputs(({ [processId]: _dropped, ...rest }) => rest);

  if (status === "unavailable") return null;
  if (status === "error" && processes.length === 0) {
    return (
      <Callout tone="danger" className="nova-procs" action={<Button size="sm" onClick={load}>{copy.retry}</Button>}>
        {copy.loadFailed}
      </Callout>
    );
  }
  // Nothing ran in the background: no empty section in the mission card.
  if (processes.length === 0) return null;

  const running = processes.filter((process) => process.state === "running").length;
  return (
    <section className="nova-procs" aria-label={copy.title}>
      <header className="nova-procs__header">
        <h3 className="nova-procs__title">{copy.title}</h3>
        <span className="nova-procs__summary">{copy.summary(running, processes.length)}</span>
      </header>
      {running > 0 ? <p className="nova-procs__note">{copy.readOnlyNote}</p> : null}
      <ul className="nova-procs__list">
        {processes.map((process) => {
          const state = statusOf(process);
          const command = commandOf(process);
          const output = outputs[process.id];
          return (
            <li key={process.id} className="nova-procs__item" data-process={process.id}>
              <div className="nova-procs__row">
                <code className="nova-procs__command" title={command}>
                  {command}
                </code>
                <StatusPill tone={state.tone} active={process.state === "running"}>
                  {state.label}
                </StatusPill>
              </div>
              <p className="nova-procs__meta">
                {copy.cwd(process.cwd)} · {copy.pid(process.pid)}
              </p>
              <div className="nova-procs__actions">
                {process.state === "running" ? (
                  <Button
                    size="sm"
                    variant="danger"
                    aria-label={copy.stopLabel(command)}
                    loading={stopping[process.id] === true}
                    onClick={() => void stop(process)}
                  >
                    {copy.stop}
                  </Button>
                ) : null}
                {process.terminalSessionId !== null && onShowTerminal ? (
                  <Button size="sm" variant="ghost" onClick={() => onShowTerminal(process.terminalSessionId as string)}>
                    {copy.showTerminal}
                  </Button>
                ) : null}
                {output ? (
                  <>
                    <Button size="sm" variant="ghost" loading={output.status === "loading"} onClick={() => void readOutput(process.id)}>
                      {copy.refreshOutput}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => hideOutput(process.id)}>
                      {copy.hideOutput}
                    </Button>
                  </>
                ) : (
                  <Button size="sm" variant="ghost" onClick={() => void readOutput(process.id)}>
                    {copy.showOutput}
                  </Button>
                )}
              </div>
              {errors[process.id] ? (
                <p className="nova-procs__error" role="alert">
                  {errors[process.id]}
                </p>
              ) : null}
              {output?.status === "error" ? (
                <p className="nova-procs__error" role="alert">
                  {output.message}
                </p>
              ) : null}
              {output?.status === "ready" ? (
                <figure className="nova-procs__output">
                  <pre aria-label={copy.outputLabel(command)}>
                    {output.output.text || copy.noOutput}
                  </pre>
                  {output.output.truncated ? (
                    <figcaption>{copy.outputTruncated(output.output.text.length, output.output.totalChars)}</figcaption>
                  ) : null}
                </figure>
              ) : null}
            </li>
          );
        })}
      </ul>
      <div className="nv-visually-hidden" aria-live="polite">
        {announcement}
      </div>
    </section>
  );
}
