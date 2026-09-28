// L4 — card body of a run_chain result. Each call of the program has its own card, nested under
// this one by the timeline (chain-view `nestChainCalls`). Owned by L4.
import type { ReactNode } from "react";
import type { ToolDisplay } from "@nova/shared";
import { CHAIN_STATE_LABELS, chainCopy } from "../../../copy/fr-chain";
import type { ChainRunView } from "../../missions/harness/chain-view";
import type { TimelineItem } from "../../missions/timeline";

const copy = chainCopy.display;

export function ChainDisplay({ display }: { display: Extract<ToolDisplay, { kind: "chain" }> }) {
  const stopped = display.state !== "succeeded";
  return (
    <>
      <p className="nova-tool__fact">
        {CHAIN_STATE_LABELS[display.state]} · {copy.calls(display.toolCalls)} · {copy.duration(display.durationMs)}
      </p>
      {display.state === "succeeded" ? (
        display.resultPreview ? (
          <>
            <p className="nova-tool__subhead">{copy.result}</p>
            <pre className="nova-tool__pre">{display.resultPreview}</pre>
          </>
        ) : (
          <p className="nova-note">{copy.noResult}</p>
        )
      ) : null}
      {stopped && display.toolCalls > 0 ? <p className="nova-note">{copy.stoppedCallsNote}</p> : null}
    </>
  );
}

export interface ChainCallsProps {
  /** The program's run (chain-view `chainRunOf`); null when its events are not in the log. */
  run: ChainRunView | null;
  /** The program's calls and their approvals (chain-view `nestChainCalls().children`). */
  items: readonly TimelineItem[];
  /** How the timeline renders one item (the same card as a direct call). */
  renderItem(item: TimelineItem): ReactNode;
}

/** What goes under a run_chain card: the program (folded) and each call it made, in order. */
export function ChainCalls({ run, items, renderItem }: ChainCallsProps) {
  const timeline = chainCopy.timeline;
  return (
    <div className="nova-chain">
      {run?.programPreview ? (
        <details className="nova-chain__program">
          <summary>{timeline.program}</summary>
          <pre className="nova-tool__pre">{run.programPreview}</pre>
        </details>
      ) : run ? (
        <p className="nova-note">{timeline.programUnknown}</p>
      ) : null}
      {items.length > 0 ? (
        <ol className="nova-chain__calls" aria-label={timeline.children(items.filter((item) => item.kind === "tool").length)}>
          {items.map((item) => (
            <li key={item.id}>{renderItem(item)}</li>
          ))}
        </ol>
      ) : (
        <p className="nova-note">{timeline.noChildren}</p>
      )}
    </div>
  );
}
