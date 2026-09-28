// Explorer column (VISUAL.md §3): conversations, project files, project search or missions, chosen
// from the rail. The file tree and the search belong to the editor lane; this column hosts them.
import { useMemo } from "react";
import { Button, EmptyState, IconButton, useToast } from "@nova/ui";
import { fr } from "../../copy/fr";
import { errorToast } from "../../lib/errors";
import { useApp } from "../../state/context";
import { liveMission } from "../../state/store";
import { FileTree } from "../files/FileTree";
import { ProjectSearch } from "../files/ProjectSearch";
import { CloseIcon } from "../icons";
import { MissionList } from "../missions/MissionList";
import { missionFacts } from "../missions/timeline";
import { NomiDock } from "./NomiDock";
import { Sidebar } from "./Sidebar";

const copy = fr.atelier.shell;

function OpenFolderEmpty() {
  const openWorkspace = useApp((state) => state.openWorkspace);
  const toast = useToast();
  return (
    <EmptyState
      title={copy.noWorkspace}
      description={copy.noWorkspaceBody}
      headingLevel={3}
      action={
        <Button
          variant="primary"
          size="sm"
          onClick={() => openWorkspace().catch((error: unknown) => toast.show(errorToast(error, copy.folderOpenFailed)))}
        >
          {copy.openFolder}
        </Button>
      }
    />
  );
}

function WorkspaceHeader() {
  const workspace = useApp((state) => state.workspace.current);
  const closeWorkspace = useApp((state) => state.closeWorkspace);
  const toast = useToast();
  if (!workspace) return null;
  return (
    <div className="nova-explorer__workspace">
      <span className="nova-explorer__workspace-name" title={workspace.displayPath}>
        {workspace.name}
      </span>
      <IconButton
        size="sm"
        aria-label={copy.closeFolder}
        icon={<CloseIcon size={14} />}
        onClick={() => closeWorkspace().catch((error: unknown) => toast.show(errorToast(error, copy.closeFolder)))}
      />
    </div>
  );
}

/** Paths the running (or shown) mission touched: the tree marks them with Nomi's dot. */
function useTouchedPaths(): ReadonlySet<string> {
  const view = useApp((state) => liveMission(state) ?? (state.missions.selectedId ? state.missions.views[state.missions.selectedId] : null) ?? null);
  return useMemo(() => new Set(view ? missionFacts(view).files.map((file) => file.path) : []), [view]);
}

function FilesView() {
  const hasWorkspace = useApp((state) => state.workspace.current !== null);
  const revealFile = useApp((state) => state.revealFile);
  const touched = useTouchedPaths();
  if (!hasWorkspace) return <OpenFolderEmpty />;
  return (
    <>
      <WorkspaceHeader />
      <FileTree agentTouchedPaths={touched} onOpenFile={(path) => revealFile(path, null)} label={copy.files} />
    </>
  );
}

export function Explorer() {
  const view = useApp((state) => state.ui.explorer);
  const hasWorkspace = useApp((state) => state.workspace.current !== null);
  const showExplorer = useApp((state) => state.showExplorer);
  if (view === "conversations") {
    return (
      <nav className="nova-zone nova-zone--nav" aria-label={fr.nav.label}>
        <Sidebar />
      </nav>
    );
  }
  const title = view === "files" ? copy.files : view === "search" ? copy.search : copy.missions;
  return (
    <section className="nova-zone nova-zone--nav nova-explorer" aria-label={`${copy.explorerLabel} : ${title}`}>
      <h2 className="nova-explorer__title">{title}</h2>
      <div className="nova-explorer__body">
        {view === "files" ? <FilesView /> : null}
        {view === "search" ? hasWorkspace ? <ProjectSearch onClose={() => showExplorer("files")} /> : <OpenFolderEmpty /> : null}
        {view === "missions" ? hasWorkspace ? <MissionList /> : <OpenFolderEmpty /> : null}
      </div>
      <div className="nova-explorer__bottom">
        <NomiDock />
      </div>
    </section>
  );
}
