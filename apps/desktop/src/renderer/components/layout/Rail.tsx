// Rail (VISUAL.md §3): the spaces of the atelier. Buttons name themselves; the current one is marked.
import type { ReactNode } from "react";
import { fr } from "../../copy/fr";
import { MOD_KEY } from "../../lib/platform";
import { useApp } from "../../state/context";
import type { ExplorerView } from "../../state/store";
import { HomeIcon, SettingsIcon } from "../icons";
import { ConversationsIcon, FolderIcon, MissionIcon, PlugIcon, SearchFilesIcon } from "./rail-icons";

const copy = fr.atelier.shell;

function RailButton({
  label,
  icon,
  current,
  shortcut,
  onClick,
}: {
  label: string;
  icon: ReactNode;
  current: boolean;
  shortcut?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="nova-rail__button"
      aria-label={label}
      aria-current={current ? "page" : undefined}
      title={shortcut ? `${label} (${shortcut})` : label}
      onClick={onClick}
    >
      {icon}
    </button>
  );
}

export function Rail() {
  const route = useApp((state) => state.ui.route);
  const explorer = useApp((state) => state.ui.explorer);
  const explorerOpen = useApp((state) => state.ui.explorerOpen);
  const hasWorkspace = useApp((state) => state.workspace.current !== null);
  const extensionsActive = useApp((state) => state.ui.activeDoc === "extensions");
  const goHome = useApp((state) => state.goHome);
  const showExplorer = useApp((state) => state.showExplorer);
  const setUi = useApp((state) => state.setUi);
  const openDoc = useApp((state) => state.openDoc);
  const openSettings = useApp((state) => state.openSettings);

  const toggle = (view: ExplorerView) => {
    if (explorerOpen && explorer === view) setUi({ explorerOpen: false });
    else showExplorer(view);
  };
  const explorerCurrent = (view: ExplorerView) => explorerOpen && explorer === view;

  return (
    <nav className="nova-rail" aria-label={copy.railLabel}>
      <RailButton label={copy.home} icon={<HomeIcon />} current={route === "home"} onClick={goHome} />
      <RailButton
        label={copy.conversations}
        icon={<ConversationsIcon />}
        current={explorerCurrent("conversations")}
        onClick={() => toggle("conversations")}
      />
      <RailButton
        label={copy.files}
        icon={<FolderIcon />}
        current={explorerCurrent("files")}
        shortcut={`${MOD_KEY}+B`}
        onClick={() => toggle("files")}
      />
      {hasWorkspace ? (
        <RailButton
          label={copy.search}
          icon={<SearchFilesIcon />}
          current={explorerCurrent("search")}
          shortcut={`${MOD_KEY}+Maj+F`}
          onClick={() => toggle("search")}
        />
      ) : null}
      <RailButton label={copy.missions} icon={<MissionIcon />} current={explorerCurrent("missions")} onClick={() => toggle("missions")} />
      <RailButton label={copy.extensions} icon={<PlugIcon />} current={extensionsActive} onClick={() => openDoc({ kind: "extensions" })} />
      <span className="nova-rail__spacer" />
      <RailButton
        label={copy.settings}
        icon={<SettingsIcon />}
        current={route === "settings"}
        shortcut={`${MOD_KEY}+,`}
        onClick={() => openSettings()}
      />
    </nav>
  );
}
