// L5 — card body of a start_submission result. Owned by L5.
import type { ToolDisplay } from "@nova/shared";
import { SUBMISSION_INTEGRATION_LABELS, submissionsCopy } from "../../../copy/fr-submissions";
import { formatCost } from "../../../lib/format";

const copy = submissionsCopy.display;

export function SubmissionDisplay({ display }: { display: Extract<ToolDisplay, { kind: "submission" }> }) {
  const reserved = formatCost(display.reservedUsd);
  // At start, a writing child has no integration state yet (it is decided when it ends).
  const where =
    display.integration === null
      ? copy.worksInCopy
      : display.integration === "not_needed"
        ? submissionsCopy.tree.readOnly
        : SUBMISSION_INTEGRATION_LABELS[display.integration];
  return (
    <p className="nova-tool__fact">
      {copy.started(display.title)} · {reserved ? copy.reserved(reserved) : copy.reservedUnknown} · {where}
    </p>
  );
}
