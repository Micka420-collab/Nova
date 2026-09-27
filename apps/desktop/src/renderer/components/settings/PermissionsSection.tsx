// Réglages › Permissions (S1, UX.md §7.1/§7.2): profile of the open project, honest isolation level,
// and the approvals remembered for a mission or the project. Saving is explicit (VISUAL.md §4.8).
import { useId, useState } from "react";
import { Button, Callout, EmptyState, useToast } from "@nova/ui";
import { PERMISSION_PROFILES, type Approval, type PermissionProfile, type PermissionProfileState } from "@nova/shared";
import { fr } from "../../copy/fr";
import { APPROVAL_SCOPE_LABELS, OPERATION_LABELS, PROFILE_HINTS, PROFILE_LABELS } from "../../copy/fr-atelier";
import { errorToast } from "../../lib/errors";
import { useApp, useClient } from "../../state/context";
import { approvalTarget, formatDateTime, SectionError, SectionLoading, useLoaded } from "./section-states";

const copy = fr.atelierSettings.permissions;

function ProfileForm({ state, onSaved }: { state: PermissionProfileState; onSaved: (next: PermissionProfileState) => void }) {
  const client = useClient();
  const toast = useToast();
  const id = useId();
  const [choice, setChoice] = useState<PermissionProfile>(state.profile);
  const [saving, setSaving] = useState(false);
  const dirty = choice !== state.profile;
  // The banner follows the choice: it warns before saving Autonomous at L0.
  const banner = choice === "autonomous" && state.isolationLevel === "L0";

  async function save() {
    setSaving(true);
    try {
      const next = await client.permissions.setProfile({ workspaceId: state.workspaceId, profile: choice });
      onSaved(next);
      toast.show({ title: fr.atelierSettings.common.saved, description: PROFILE_LABELS[next.profile], tone: "success" });
    } catch (error) {
      toast.show(errorToast(error, fr.atelierSettings.common.saveFailed));
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <fieldset className="nova-choices">
        <legend className="nv-field__label">{copy.profileLegend}</legend>
        {PERMISSION_PROFILES.map((profile) => (
          <label key={profile} className="nova-choice">
            <input
              type="radio"
              name={`${id}-profile`}
              value={profile}
              checked={choice === profile}
              onChange={() => setChoice(profile)}
            />
            <span className="nova-choice__label">{PROFILE_LABELS[profile]}</span>
            <span className="nova-choice__hint">{PROFILE_HINTS[profile]}</span>
          </label>
        ))}
      </fieldset>
      <dl className="nova-facts">
        <dt>{copy.isolation}</dt>
        <dd>
          <code>{state.isolationLevel}</code> · {copy.isolationLevels[state.isolationLevel]}
        </dd>
      </dl>
      {banner ? <Callout tone="warning">{copy.autonomousBanner}</Callout> : null}
      <div className="nova-actions">
        <Button variant="primary" loading={saving} disabled={!dirty} onClick={() => void save()}>
          {fr.atelierSettings.common.save}
        </Button>
        {!dirty ? <span className="nova-note">{copy.unchanged}</span> : null}
      </div>
    </>
  );
}

function RememberedApprovals({ workspaceId }: { workspaceId: string }) {
  const client = useClient();
  const [loaded, retry] = useLoaded<Approval[]>(workspaceId, () =>
    client.approvals.list({ workspaceId, missionId: null, status: "approved" }),
  );
  return (
    <section className="nova-aset-block" aria-labelledby="aset-remembered">
      <h3 id="aset-remembered" className="nova-subheading">
        {copy.rememberedTitle}
      </h3>
      <p className="nova-note">{copy.rememberedIntro}</p>
      {loaded.status === "loading" ? <SectionLoading /> : null}
      {loaded.status === "error" ? <SectionError error={loaded.error} onRetry={retry} /> : null}
      {loaded.status === "ready" ? <RememberedTable approvals={loaded.data} /> : null}
    </section>
  );
}

function RememberedTable({ approvals }: { approvals: Approval[] }) {
  const remembered = approvals
    .filter((approval) => approval.scope === "mission" || approval.scope === "project")
    .toSorted((a, b) => (b.decidedAt ?? b.createdAt) - (a.decidedAt ?? a.createdAt));
  if (remembered.length === 0) return <p className="nova-aset-empty">{copy.rememberedEmpty}</p>;
  return (
    <div className="nova-aset-table-wrap">
      <table className="nova-aset-table">
        <thead>
          <tr>
            <th scope="col">{copy.colTool}</th>
            <th scope="col">{copy.colOperation}</th>
            <th scope="col">{copy.colTarget}</th>
            <th scope="col">{copy.colScope}</th>
            <th scope="col">{copy.colDate}</th>
          </tr>
        </thead>
        <tbody>
          {remembered.map((approval) => (
            <tr key={approval.id}>
              <td>
                <code>{approval.request.tool}</code>
              </td>
              <td>{OPERATION_LABELS[approval.request.operation]}</td>
              <td>
                <code className="nova-aset-target">{approvalTarget(approval.request)}</code>
              </td>
              <td>{approval.scope ? APPROVAL_SCOPE_LABELS[approval.scope] : fr.app.unknown}</td>
              <td>{formatDateTime(approval.decidedAt ?? approval.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function PermissionsSection() {
  const workspace = useApp((state) => state.workspace.current);
  const client = useClient();
  const workspaceId = workspace?.id ?? null;
  const [loaded, retry, replace] = useLoaded<PermissionProfileState | null>(workspaceId, () =>
    workspaceId ? client.permissions.getProfile({ workspaceId }) : Promise.resolve(null),
  );

  if (!workspace) {
    return <EmptyState title={fr.atelierSettings.common.noWorkspace} description={copy.noWorkspaceBody} headingLevel={3} />;
  }
  return (
    <div className="nova-aset">
      {loaded.status === "loading" ? <SectionLoading /> : null}
      {loaded.status === "error" ? <SectionError error={loaded.error} onRetry={retry} /> : null}
      {loaded.status === "ready" && loaded.data ? (
        <ProfileForm key={`${loaded.data.profile}`} state={loaded.data} onSaved={replace} />
      ) : null}
      <RememberedApprovals workspaceId={workspace.id} />
    </div>
  );
}
