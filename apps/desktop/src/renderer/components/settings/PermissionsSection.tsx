// Réglages › Permissions (S1, UX.md §7.1/§7.2): profile of the open project, honest isolation level,
// and the approvals remembered for a mission or the project. Saving is explicit (VISUAL.md §4.8).
import { useId, useState } from "react";
import { Button, Callout, EmptyState, useToast } from "@nova/ui";
import {
  PERMISSION_PROFILES,
  SENSITIVE_PATH_PATTERNS,
  type PermissionProfile,
  type PermissionProfileState,
  type PermissionRule,
} from "@nova/shared";
import { fr } from "../../copy/fr";
import { APPROVAL_SCOPE_LABELS, OPERATION_LABELS, PROFILE_HINTS, PROFILE_LABELS } from "../../copy/fr-atelier";
import { errorToast } from "../../lib/errors";
import { useApp, useClient } from "../../state/context";
import { formatDateTime, SectionError, SectionLoading, useLoaded } from "./section-states";

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

function ruleTarget(rule: PermissionRule): string {
  if (rule.host) return rule.host;
  if (rule.pathGlob) return rule.pathGlob;
  return copy.anyTarget;
}

function RememberedRules({ workspaceId }: { workspaceId: string }) {
  const client = useClient();
  const toast = useToast();
  const [loaded, retry, replace] = useLoaded<PermissionRule[]>(workspaceId, () => client.permissions.listRules({ workspaceId }));
  const [confirmAll, setConfirmAll] = useState(false);
  const [busy, setBusy] = useState(false);

  async function revoke(ruleId: string | null) {
    setBusy(true);
    try {
      const count = await client.permissions.revokeRules({ workspaceId, ruleId });
      replace(await client.permissions.listRules({ workspaceId }));
      toast.show({ title: copy.revoked(count), tone: "success" });
    } catch (error) {
      toast.show(errorToast(error, fr.atelierSettings.common.saveFailed));
    } finally {
      setBusy(false);
      setConfirmAll(false);
    }
  }

  return (
    <section className="nova-aset-block" aria-labelledby="aset-remembered">
      <h3 id="aset-remembered" className="nova-subheading">
        {copy.rememberedTitle}
      </h3>
      <p className="nova-note">{copy.rememberedIntro}</p>
      {loaded.status === "loading" ? <SectionLoading /> : null}
      {loaded.status === "error" ? <SectionError error={loaded.error} onRetry={retry} /> : null}
      {loaded.status === "ready" && loaded.data.length === 0 ? <p className="nova-aset-empty">{copy.rememberedEmpty}</p> : null}
      {loaded.status === "ready" && loaded.data.length > 0 ? (
        <>
          <div className="nova-aset-table-wrap">
            <table className="nova-aset-table">
              <thead>
                <tr>
                  <th scope="col">{copy.colTool}</th>
                  <th scope="col">{copy.colOperation}</th>
                  <th scope="col">{copy.colTarget}</th>
                  <th scope="col">{copy.colScope}</th>
                  <th scope="col">{copy.colDate}</th>
                  <th scope="col">
                    <span className="nv-visually-hidden">{copy.colActions}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {loaded.data.map((rule) => (
                  <tr key={rule.id}>
                    <td>{rule.tool ? <code>{rule.tool}</code> : copy.anyTool}</td>
                    <td>{rule.operation ? OPERATION_LABELS[rule.operation] : fr.app.unknown}</td>
                    <td>
                      <code className="nova-aset-target">{ruleTarget(rule)}</code>
                    </td>
                    <td>{APPROVAL_SCOPE_LABELS[rule.scope]}</td>
                    <td>{formatDateTime(rule.createdAt)}</td>
                    <td>
                      <Button size="sm" variant="ghost" disabled={busy} onClick={() => void revoke(rule.id)}>
                        {copy.revoke}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="nova-actions">
            {confirmAll ? (
              <>
                <span className="nova-note">{copy.revokeAllConfirm(loaded.data.length)}</span>
                <Button variant="danger" size="sm" loading={busy} onClick={() => void revoke(null)}>
                  {copy.revokeAll}
                </Button>
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirmAll(false)}>
                  {fr.atelierSettings.common.cancel}
                </Button>
              </>
            ) : (
              <Button variant="secondary" size="sm" disabled={busy} onClick={() => setConfirmAll(true)}>
                {copy.revokeAll}
              </Button>
            )}
          </div>
        </>
      ) : null}
    </section>
  );
}

/** C8: the list is visible (FEATURES C8); `.novaignore` adds to it, never removes. */
function SensitiveFiles() {
  return (
    <section className="nova-aset-block" aria-labelledby="aset-sensitive">
      <h3 id="aset-sensitive" className="nova-subheading">
        {copy.sensitiveTitle}
      </h3>
      <p className="nova-note">{copy.sensitiveIntro}</p>
      <ul className="nova-aset-patterns">
        {SENSITIVE_PATH_PATTERNS.map((pattern) => (
          <li key={pattern}>
            <code>{pattern}</code>
            {pattern.startsWith("!") ? <span className="nova-note"> · {copy.sensitiveAllowed}</span> : null}
          </li>
        ))}
      </ul>
    </section>
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
      <RememberedRules workspaceId={workspace.id} />
      <SensitiveFiles />
    </div>
  );
}
