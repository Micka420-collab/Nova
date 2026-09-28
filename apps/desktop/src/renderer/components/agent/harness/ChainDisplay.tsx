// L4 — card body of a run_chain result (each inner call has its own card). Owned by L4.
import type { ToolDisplay } from "@nova/shared";
import { CHAIN_STATE_LABELS, chainCopy } from "../../../copy/fr-chain";

const copy = chainCopy.display;

export function ChainDisplay({ display }: { display: Extract<ToolDisplay, { kind: "chain" }> }) {
  return (
    <>
      <p className="nova-tool__fact">
        {CHAIN_STATE_LABELS[display.state]} · {copy.calls(display.toolCalls)}
      </p>
      {display.resultPreview ? (
        <>
          <p className="nova-tool__subhead">{copy.result}</p>
          <pre className="nova-tool__pre">{display.resultPreview}</pre>
        </>
      ) : null}
    </>
  );
}
