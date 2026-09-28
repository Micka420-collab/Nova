// L3 — Extensions › Skills (M8): shipped, installed and project skills; install from a folder after
// a preview; enable per project (a project skill only after a preview of its current content);
// view the content; uninstall without residue. Everything shown comes from main (`skills.*`).
import { useEffect, useReducer, useState } from "react";
import { Badge, Button, Callout, Skeleton, Switch, useToast } from "@nova/ui";
import { NovaIpcError, type SkillMeta, type SkillPreview, type SkillScope, type Workspace } from "@nova/shared";
import { SKILL_SCOPE_LABELS, skillsCopy } from "../../copy/fr-skills";
import { useApp, useClient } from "../../state/context";
import { reduceSkillsList, skillsOfScope } from "../../state/skills-slice";
import { ConfirmDialog } from "../layout/ConversationDialogs";
import { SkillPreviewDialog, type SkillDialogMode, type SkillDialogState } from "./SkillPreviewDialog";
import { skillErrorText, skillLabel } from "./skill-errors";
// oxlint-disable-next-line import/no-unassigned-import -- side-effect stylesheet (extracted to a file by Vite)
import "./skills.css";

const t = skillsCopy.manager;

interface DialogTarget {
  mode: SkillDialogMode;
  state: SkillDialogState;
  /** The skill a view/enable dialog is about (install: none until the preview arrives). */
  skill: SkillMeta | null;
}

function SkillRow({
  skill,
  workspace,
  busy,
  onToggle,
  onView,
  onUninstall,
}: {
  skill: SkillMeta;
  workspace: Workspace | null;
  busy: boolean;
  onToggle: (enabled: boolean) => void;
  onView: () => void;
  onUninstall: () => void;
}) {
  const label = skillLabel(skill);
  return (
    <li className="nova-skill-row" aria-label={label}>
      <div className="nova-skill-row__main">
        <span className="nova-skill-row__name">{label}</span>
        <Badge tone={skill.scope === "builtin" ? "jade" : "neutral"}>{SKILL_SCOPE_LABELS[skill.scope]}</Badge>
        <p className="nova-skill-row__description">{skill.description}</p>
        <p className="nova-skill-row__meta">{t.meta(skill.fileCount, skill.version)}</p>
      </div>
      <div className="nova-skill-row__actions">
        {workspace ? (
          <Switch
            checked={skill.enabled}
            disabled={busy}
            label={t.enableFor(workspace.name)}
            onCheckedChange={onToggle}
          />
        ) : null}
        <Button size="sm" variant="secondary" onClick={onView}>
          {t.view}
        </Button>
        {skill.scope === "user" ? (
          <Button size="sm" variant="ghost" onClick={onUninstall}>
            {t.uninstall}
          </Button>
        ) : null}
      </div>
    </li>
  );
}

export function SkillsManager() {
  const client = useClient();
  const toast = useToast();
  const workspace = useApp((state) => state.workspace.current);
  const workspaceId = workspace?.id ?? null;
  const [list, dispatch] = useReducer(reduceSkillsList, { status: "loading" });
  const [reload, setReload] = useState(0);
  const [dialog, setDialog] = useState<DialogTarget | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busyRef, setBusyRef] = useState<string | null>(null);
  const [uninstallTarget, setUninstallTarget] = useState<SkillMeta | null>(null);

  // Re-read when shown again: a project skill may have been edited on disk meanwhile.
  const shown = useApp((state) => state.ui.activeDoc === "extensions");
  const [wasShown, setWasShown] = useState(shown);
  if (shown !== wasShown) {
    setWasShown(shown);
    if (shown) setReload((value) => value + 1);
  }

  // One key per read: a retry (reload) or another project starts a new one.
  const requestKey = `${workspaceId ?? ""}#${reload}`;

  useEffect(() => {
    let current = true;
    const scoped = requestKey.split("#")[0] ?? "";
    client.skills
      .list({ workspaceId: scoped === "" ? null : scoped })
      .then((skills) => {
        if (current) dispatch({ type: "loaded", skills });
      })
      .catch((error: unknown) => {
        if (!current) return;
        if (error instanceof NovaIpcError && error.code === "unavailable") dispatch({ type: "unavailable" });
        else dispatch({ type: "failed", message: skillErrorText(error) });
      });
    return () => {
      current = false;
    };
  }, [client, requestKey]);

  const retry = () => {
    dispatch({ type: "loading" });
    setReload((value) => value + 1);
  };

  const openInstall = () => {
    setDialog({ mode: "install", state: { status: "loading" }, skill: null });
    client.skills
      .preview({ source: { kind: "picker" } })
      .then((preview) => {
        // Cancelled picker: nothing was chosen, nothing to show.
        if (preview === null) setDialog(null);
        else setDialog({ mode: "install", state: { status: "ready", detail: preview }, skill: preview.meta });
      })
      .catch((error: unknown) => setDialog({ mode: "install", state: { status: "error", message: skillErrorText(error) }, skill: null }));
  };

  const openEnable = (skill: SkillMeta) => {
    if (!workspaceId) return;
    setDialog({ mode: "enable", state: { status: "loading" }, skill });
    client.skills
      .preview({ source: { kind: "project", workspaceId, name: skill.name } })
      .then((preview) => setDialog({ mode: "enable", state: preview ? { status: "ready", detail: preview } : { status: "error", message: t.previewFailed }, skill }))
      .catch((error: unknown) => setDialog({ mode: "enable", state: { status: "error", message: skillErrorText(error) }, skill }));
  };

  const openView = (skill: SkillMeta) => {
    setDialog({ mode: "view", state: { status: "loading" }, skill });
    client.skills
      .get({ ref: skill.ref, workspaceId })
      .then((detail) => setDialog({ mode: "view", state: { status: "ready", detail }, skill }))
      .catch((error: unknown) => setDialog({ mode: "view", state: { status: "error", message: skillErrorText(error) }, skill }));
  };

  const setEnabled = async (skill: SkillMeta, enabled: boolean): Promise<boolean> => {
    if (!workspaceId) return false;
    setBusyRef(skill.ref);
    try {
      const updated = await client.skills.setEnabled({ workspaceId, ref: skill.ref, enabled });
      dispatch({ type: "upsert", skill: updated });
      toast.show({ title: (enabled ? t.enabledToast : t.disabledToast)(skillLabel(updated)), tone: "success" });
      return true;
    } catch (error) {
      if (enabled && error instanceof NovaIpcError && error.message === "skill_preview_required") {
        openEnable(skill);
        return false;
      }
      toast.show({ title: t.toggleFailed, description: skillErrorText(error), tone: "danger" });
      return false;
    } finally {
      setBusyRef(null);
    }
  };

  const toggle = (skill: SkillMeta, enabled: boolean) => {
    // A project skill is never enabled on trust: its current content is shown first.
    if (enabled && skill.scope === "project") openEnable(skill);
    else void setEnabled(skill, enabled);
  };

  const confirmDialog = async () => {
    if (!dialog || dialog.state.status !== "ready") return;
    setConfirming(true);
    try {
      if (dialog.mode === "install") {
        const preview = dialog.state.detail as SkillPreview;
        try {
          const installed = await client.skills.install({ previewId: preview.previewId });
          dispatch({ type: "upsert", skill: installed });
          toast.show({ title: skillsCopy.preview.installed(skillLabel(installed), installed.fileCount), tone: "success" });
          setDialog(null);
        } catch (error) {
          setDialog({ ...dialog, state: { status: "error", message: skillErrorText(error) } });
        }
      } else if (dialog.mode === "enable" && dialog.skill) {
        if (await setEnabled(dialog.skill, true)) setDialog(null);
      }
    } finally {
      setConfirming(false);
    }
  };

  const uninstall = async (skill: SkillMeta) => {
    try {
      await client.skills.uninstall({ ref: skill.ref });
      dispatch({ type: "removed", ref: skill.ref });
      toast.show({ title: t.uninstalled(skillLabel(skill)), tone: "success" });
    } catch (error) {
      toast.show({ title: t.uninstallFailed, description: skillErrorText(error), tone: "danger" });
      throw error;
    }
  };

  const section = (scope: SkillScope, title: string, empty: string | null) => {
    const skills = skillsOfScope(list, scope);
    return (
      <section className="nova-skills__section" aria-label={title}>
        <h2 className="nova-skills__subheading">{title}</h2>
        {skills.length === 0 && empty ? <p className="nova-note">{empty}</p> : null}
        {skills.length > 0 ? (
          <ul className="nova-skills__list" aria-label={t.listLabel(title)}>
            {skills.map((skill) => (
              <SkillRow
                key={skill.ref}
                skill={skill}
                workspace={workspace}
                busy={busyRef === skill.ref}
                onToggle={(enabled) => toggle(skill, enabled)}
                onView={() => openView(skill)}
                onUninstall={() => setUninstallTarget(skill)}
              />
            ))}
          </ul>
        ) : null}
      </section>
    );
  };

  return (
    <section className="nova-skills" aria-labelledby="nova-skills-heading">
      <header className="nova-skills__header">
        <h1 id="nova-skills-heading" className="nova-skills__title">
          {t.heading}
        </h1>
        {list.status === "ready" || list.status === "error" ? (
          <Button variant="primary" size="sm" onClick={openInstall}>
            {t.install}
          </Button>
        ) : null}
      </header>
      {list.status === "unavailable" ? <Callout tone="info">{t.unavailable}</Callout> : null}
      {list.status === "error" ? (
        <Callout
          tone="danger"
          title={t.loadFailed}
          action={
            <Button size="sm" variant="secondary" onClick={retry}>
              {t.retry}
            </Button>
          }
        >
          <p>{list.message}</p>
        </Callout>
      ) : null}
      {list.status === "loading" ? (
        <div className="nova-skills__loading" aria-busy="true">
          <p className="nv-visually-hidden">{t.loading}</p>
          <Skeleton height={56} radius={10} />
          <Skeleton height={56} radius={10} />
        </div>
      ) : null}
      {list.status === "ready" ? (
        <>
          <p className="nova-note">{t.intro}</p>
          {workspace ? null : <p className="nova-note">{t.noProject}</p>}
          {section("builtin", t.sectionBuiltin, null)}
          {section("user", t.sectionUser, t.emptyUser)}
          {workspace ? section("project", t.sectionProject, t.emptyProject) : null}
        </>
      ) : null}
      {dialog ? (
        <SkillPreviewDialog
          mode={dialog.mode}
          state={dialog.state}
          busy={confirming}
          onConfirm={() => void confirmDialog()}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {uninstallTarget ? (
        <ConfirmDialog
          title={t.uninstallTitle(skillLabel(uninstallTarget))}
          description={t.uninstallBody}
          confirmLabel={t.uninstallConfirm}
          onConfirm={() => uninstall(uninstallTarget)}
          onClose={() => setUninstallTarget(null)}
        />
      ) : null}
    </section>
  );
}
