// Réglages › Journal d'audit (S5, partial): the permission decisions recorded by main (approvals),
// newest first, with filters. The full audit log (network, costs, data sent) needs an `audit.list` API.
import { useId, useState } from "react";
import { Callout, TextField } from "@nova/ui";
import { OPERATION_CLASSES, type Approval, type ApprovalStatus, type OperationClass } from "@nova/shared";
import { fr } from "../../copy/fr";
import { APPROVAL_SCOPE_LABELS, OPERATION_LABELS, PERMISSION_REASON_LABELS } from "../../copy/fr-atelier";
import { APPROVAL_STATUS_LABELS } from "../../copy/fr-settings-atelier";
import { useApp, useClient } from "../../state/context";
import { approvalTarget, formatDateTime, SectionError, SectionLoading, useLoaded } from "./section-states";

const copy = fr.atelierSettings.audit;
const STATUSES: readonly ApprovalStatus[] = ["pending", "approved", "denied", "expired"];

export interface AuditFilters {
  status: ApprovalStatus | "all";
  operation: OperationClass | "all";
  text: string;
}

/** Decisions matching the filters, newest first. Exported for tests. */
export function filterDecisions(approvals: readonly Approval[], filters: AuditFilters): Approval[] {
  const text = filters.text.trim().toLowerCase();
  return approvals
    .filter((approval) => filters.status === "all" || approval.status === filters.status)
    .filter((approval) => filters.operation === "all" || approval.request.operation === filters.operation)
    .filter((approval) => {
      if (!text) return true;
      const { tool, path, host, argv } = approval.request;
      return [tool, path, host, argv?.join(" ")].some((value) => value?.toLowerCase().includes(text));
    })
    .toSorted((a, b) => b.createdAt - a.createdAt);
}

function DecisionsTable({ approvals }: { approvals: Approval[] }) {
  const id = useId();
  const [filters, setFilters] = useState<AuditFilters>({ status: "all", operation: "all", text: "" });
  const shown = filterDecisions(approvals, filters);
  if (approvals.length === 0) return <p className="nova-aset-empty">{copy.empty}</p>;
  return (
    <>
      <div className="nova-aset-filters">
        <label className="nv-field" htmlFor={`${id}-status`}>
          <span className="nv-field__label">{copy.filterStatus}</span>
          <select
            id={`${id}-status`}
            className="nv-field__control nova-aset-select"
            value={filters.status}
            onChange={(event) => setFilters({ ...filters, status: event.target.value as AuditFilters["status"] })}
          >
            <option value="all">{copy.all}</option>
            {STATUSES.map((status) => (
              <option key={status} value={status}>
                {APPROVAL_STATUS_LABELS[status]}
              </option>
            ))}
          </select>
        </label>
        <label className="nv-field" htmlFor={`${id}-operation`}>
          <span className="nv-field__label">{copy.filterOperation}</span>
          <select
            id={`${id}-operation`}
            className="nv-field__control nova-aset-select"
            value={filters.operation}
            onChange={(event) => setFilters({ ...filters, operation: event.target.value as AuditFilters["operation"] })}
          >
            <option value="all">{copy.all}</option>
            {OPERATION_CLASSES.map((operation) => (
              <option key={operation} value={operation}>
                {OPERATION_LABELS[operation]}
              </option>
            ))}
          </select>
        </label>
        <TextField
          label={copy.filterText}
          type="search"
          value={filters.text}
          onChange={(event) => setFilters({ ...filters, text: event.target.value })}
        />
      </div>
      <p className="nova-note" aria-live="polite">
        {copy.count(shown.length, approvals.length)}
      </p>
      {shown.length === 0 ? (
        <p className="nova-aset-empty">{copy.filteredEmpty}</p>
      ) : (
        <div className="nova-aset-table-wrap">
          <table className="nova-aset-table">
            <caption className="nv-visually-hidden">{copy.title}</caption>
            <thead>
              <tr>
                <th scope="col">{copy.colTime}</th>
                <th scope="col">{copy.colTool}</th>
                <th scope="col">{copy.colOperation}</th>
                <th scope="col">{copy.colTarget}</th>
                <th scope="col">{copy.colStatus}</th>
                <th scope="col">{copy.colReason}</th>
                <th scope="col">{copy.colScope}</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((approval) => (
                <tr key={approval.id} data-status={approval.status}>
                  <td>{formatDateTime(approval.createdAt)}</td>
                  <td>
                    <code>{approval.request.tool}</code>
                  </td>
                  <td>{OPERATION_LABELS[approval.request.operation]}</td>
                  <td>
                    <code className="nova-aset-target">{approvalTarget(approval.request)}</code>
                  </td>
                  <td>{APPROVAL_STATUS_LABELS[approval.status]}</td>
                  <td>{PERMISSION_REASON_LABELS[approval.decision.reason]}</td>
                  <td>{approval.scope ? APPROVAL_SCOPE_LABELS[approval.scope] : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

export function AuditSection() {
  const client = useClient();
  const workspaceId = useApp((state) => state.workspace.current?.id ?? null);
  const [loaded, retry] = useLoaded<Approval[]>(workspaceId ?? "all", () =>
    client.approvals.list({ workspaceId, missionId: null, status: null }),
  );
  return (
    <div className="nova-aset">
      <h3 className="nova-subheading">{copy.title}</h3>
      <Callout tone="info">{copy.intro}</Callout>
      {loaded.status === "loading" ? <SectionLoading /> : null}
      {loaded.status === "error" ? <SectionError error={loaded.error} onRetry={retry} /> : null}
      {loaded.status === "ready" ? <DecisionsTable approvals={loaded.data} /> : null}
    </div>
  );
}
