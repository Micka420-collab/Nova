// L5 — card body of a start_submission result. Owned by L5.
import type { ToolDisplay } from "@nova/shared";
import { SUBMISSION_INTEGRATION_LABELS, submissionsCopy } from "../../../copy/fr-submissions";
import { formatCost } from "../../../lib/format";

const copy = submissionsCopy.display;

export function SubmissionDisplay({ display }: { display: Extract<ToolDisplay, { kind: "submission" }> }) {
  const reserved = formatCost(display.reservedUsd);
  return (
    <p className="nova-tool__fact">
      {copy.started(display.title)} · {reserved ? copy.reserved(reserved) : copy.reservedUnknown}
      {display.integration ? ` · ${SUBMISSION_INTEGRATION_LABELS[display.integration]}` : ""}
    </p>
  );
}
