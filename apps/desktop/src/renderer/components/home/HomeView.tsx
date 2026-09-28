import { useEffect, useState } from "react";
import { Button, Callout, useToast } from "@nova/ui";
import type { ProviderConnectionView, Workspace } from "@nova/shared";
import { fr } from "../../copy/fr";
import { formatRelative } from "../../lib/format";
import { useNow } from "../../lib/hooks";
import { useAtelier } from "../editor/atelier-context";
import { useApp, useClient } from "../../state/context";
import { selectedModelId } from "../../state/store";
import { Composer } from "../chat/Composer";
import { useSendGuard } from "../chat/useSendGuard";
import { SendFailure } from "../chat/SendFailure";
import { useSendMessage } from "../chat/useSendMessage";
import { findModel } from "../models/filter";
import { Onboarding } from "../setup/Onboarding";
import { errorToast } from "../../lib/errors";

const RECENT_COUNT = 5;
const copy = fr.atelier.home;

/**
 * Folders opened before (newest first), reopened by id without the picker. Hidden when none.
 * Mounted with the open folder as key: opening another one reads the list again.
 */
function RecentFolders({ currentId }: { currentId: string | null }) {
  const client = useClient();
  const reopenWorkspace = useApp((state) => state.reopenWorkspace);
  const toast = useToast();
  const [recent, setRecent] = useState<Workspace[]>([]);
  useEffect(() => {
    let current = true;
    client.workspace
      .recent({ limit: RECENT_COUNT + 1 })
      .then((list) => current && setRecent(list))
      // No list, no section: the picker stays the way in.
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [client]);
  const others = recent.filter((workspace) => workspace.id !== currentId).slice(0, RECENT_COUNT);
  if (others.length === 0) return null;
  return (
    <div className="nova-home__recent">
      <h3 className="nova-subheading">{copy.recentTitle}</h3>
      <ul className="nova-home__recent-list">
        {others.map((workspace) => (
          <li key={workspace.id}>
            <Button
              variant="ghost"
              size="sm"
              aria-label={copy.reopen(workspace.name)}
              onClick={() =>
                reopenWorkspace(workspace.id).catch((error: unknown) => toast.show(errorToast(error, fr.atelier.shell.folderOpenFailed)))
              }
            >
              {workspace.name}
            </Button>
            <code className="nova-note">{workspace.displayPath}</code>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** "Ouvrir un dossier" (UX.md minute 3): same weight as the new idea; facts once a folder is open. */
function FolderCard() {
  const workspace = useApp((state) => state.workspace.current);
  const facts = useApp((state) => state.workspace.facts);
  const git = useAtelier((state) => state.explorer.git);
  const loading = useApp((state) => state.workspace.status === "loading");
  const openWorkspace = useApp((state) => state.openWorkspace);
  const setUi = useApp((state) => state.setUi);
  const selectMission = useApp((state) => state.selectMission);
  const finishedSelected = useApp((state) => {
    const id = state.missions.selectedId;
    const mission = id ? state.missions.views[id]?.mission : undefined;
    return mission !== undefined && ["succeeded", "failed", "cancelled"].includes(mission.state);
  });
  const setWorkMode = useApp((state) => state.setWorkMode);
  const toast = useToast();
  const open = () => {
    openWorkspace().catch((error: unknown) => toast.show(errorToast(error, fr.atelier.shell.folderOpenFailed)));
  };
  // A runner NOVA does not name ("other") is shown by the command it will run, never as "other".
  const runner = facts?.testRunner ? (facts.testRunner.name === "other" ? facts.testRunner.command.join(" ") : facts.testRunner.name) : null;
  const stack = facts ? [...facts.frameworks, ...facts.languages, runner].filter(Boolean).join(" · ") : "";
  return (
    <section className="nova-card nova-home__folder" aria-labelledby="home-open-folder">
      <div className="nova-card__header">
        <h2 id="home-open-folder" className="nova-card__title">
          {workspace ? copy.currentFolder(workspace.name) : copy.openFolderTitle}
        </h2>
      </div>
      {workspace ? (
        <>
          <p className="nova-note">
            <code>{workspace.displayPath}</code>
          </p>
          <ul className="nova-home__facts">
            {facts ? <li>{stack ? copy.facts(stack) : copy.factsUnknown}</li> : null}
            {git ? <li>{git.available ? copy.git(git.branch ?? fr.atelier.statusBar.detached) : copy.gitNone}</li> : null}
            <li>{copy.nothingSent}</li>
          </ul>
          <div className="nova-home__folder-actions">
            <Button
              variant="primary"
              size="sm"
              onClick={() => {
                // A new mission: a finished one stays in the mission list, not in the way of the composer.
                if (finishedSelected) selectMission(null);
                setWorkMode("understand");
                setUi({ route: "chat", agentOpen: true });
              }}
            >
              {copy.goToAgent}
            </Button>
            <Button variant="ghost" size="sm" loading={loading} onClick={open}>
              {copy.openFolderAction}
            </Button>
          </div>
        </>
      ) : (
        <>
          <p className="nova-lead">{copy.openFolderBody}</p>
          <Button variant="secondary" loading={loading} onClick={open}>
            {copy.openFolderAction}
          </Button>
        </>
      )}
      <RecentFolders key={workspace?.id ?? "none"} currentId={workspace?.id ?? null} />
    </section>
  );
}

export function HomeView() {
  const connection = useApp((state) => state.connection);
  const vaultLevel = useApp((state) => state.appInfo?.vault.level ?? null);
  const modelId = useApp((state) => selectedModelId(state, null));
  const models = useApp((state) => state.catalog.data?.models);
  const conversations = useApp((state) => state.conversations);
  const query = useApp((state) => state.query);
  const openConversation = useApp((state) => state.openConversation);
  const openModelPicker = useApp((state) => state.openModelPicker);
  const openSettings = useApp((state) => state.openSettings);
  const [saved, setSaved] = useState<ProviderConnectionView | null>(null);
  const guard = useSendGuard(modelId, "new");
  const draft = useSendMessage(null);
  const now = useNow(60_000);

  if (connection?.state === "absent" || saved) {
    return <Onboarding saved={saved} onSaved={setSaved} onDone={() => setSaved(null)} />;
  }

  const model = findModel(models, modelId);
  // The sidebar search filters the shared list; recents only make sense unfiltered.
  const recent = query.trim() === "" ? conversations.slice(0, RECENT_COUNT) : [];
  return (
    <div className="nova-home">
      <header className="nova-home__header">
        <h1 className="nova-home__title">{fr.home.title}</h1>
        <p className="nova-lead">{fr.home.subtitle}</p>
      </header>

      {connection?.state === "invalid" ? (
        <Callout
          tone="danger"
          title={fr.composer.invalidKey}
          action={
            <Button size="sm" variant="secondary" onClick={() => openSettings("providers")}>
              {fr.providers.replace}
            </Button>
          }
        />
      ) : null}
      {vaultLevel === "weak" ? <Callout tone="warning">{fr.home.vaultWeak}</Callout> : null}
      {vaultLevel === "unavailable" ? <Callout tone="warning">{fr.home.vaultUnavailable}</Callout> : null}

      <section className="nova-card" aria-labelledby="home-new-idea">
        <div className="nova-card__header">
          <h2 id="home-new-idea" className="nova-card__title">
            {fr.home.newIdea}
          </h2>
          {modelId ? (
            <Button size="sm" variant="ghost" onClick={() => openModelPicker("new")}>
              {fr.home.currentModel(model?.name ?? modelId)} · {fr.home.changeModel}
            </Button>
          ) : null}
        </div>
        {!modelId ? (
          <Callout
            tone="info"
            title={fr.home.chooseModelTitle}
            action={
              <Button size="sm" variant="primary" onClick={() => openModelPicker("new")}>
                {fr.home.chooseModelAction}
              </Button>
            }
          >
            <p>{fr.home.chooseModelBody}</p>
          </Callout>
        ) : null}
        {draft.error ? <SendFailure error={draft.error} /> : null}
        <Composer
          label={fr.home.newIdeaLabel}
          placeholder={fr.home.newIdeaPlaceholder}
          streaming={false}
          blocked={guard}
          value={draft.text}
          onValueChange={draft.setText}
          onSend={draft.send}
          onStop={() => undefined}
          autoFocus
        />
      </section>

      <FolderCard />

      {recent.length > 0 ? (
        <section className="nova-card" aria-labelledby="home-resume">
          <h2 id="home-resume" className="nova-card__title">
            {fr.home.resume}
          </h2>
          <ul className="nova-recent">
            {recent.map((item) => (
              <li key={item.id}>
                <button type="button" className="nova-recent__item" onClick={() => openConversation(item.id)}>
                  <span className="nova-recent__title">{item.title}</span>
                  {item.preview ? <span className="nova-recent__preview">{item.preview}</span> : null}
                  <span className="nova-recent__time">{formatRelative(item.updatedAt, now)}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
