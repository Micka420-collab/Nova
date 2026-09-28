// L1 — card body of process_list / process_output / process_stop results. Owned by L1.
import type { MissionProcessState, ToolDisplay } from "@nova/shared";
import { processesCopy } from "../../../copy/fr-processes";

const copy = processesCopy.display;

export function ProcessDisplay({ display }: { display: Extract<ToolDisplay, { kind: "process" }> }) {
  const stateLabel = (state: MissionProcessState, exitCode: number | null) =>
    state === "running" ? copy.running : state === "stopped" ? copy.stoppedState : state === "handed_over" ? copy.handedOver : copy.exited(exitCode);
  return (
    <>
      <p className="nova-tool__fact">
        {display.action === "stop"
          ? display.processes[0]?.state === "stopped"
            ? copy.stopped
            : copy.alreadyEnded
          : copy.list(display.processes.length)}
      </p>
      {display.processes.length > 0 ? (
        <ul className="nova-tool__list">
          {display.processes.map((process) => (
            <li key={process.id}>
              <code>{process.argv.join(" ")}</code> · {stateLabel(process.state, process.exitCode)}
              {process.cwd !== "" ? <> · {process.cwd}</> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {display.action === "output" ? <pre className="nova-tool__pre">{display.outputTail || copy.noOutput}</pre> : null}
    </>
  );
}
