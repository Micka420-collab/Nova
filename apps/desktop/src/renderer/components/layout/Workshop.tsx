// Atelier shell (VISUAL.md §3): rail · explorer · center · right column, and the status bar.
// `data-layout="converse"`: the thread is in the center, the workbench on the right.
// `data-layout="build"`: the workbench (+ dock) is in the center, the agent panel on the right.
// Below 900 px the explorer becomes a drawer and the workbench an overlay, so nothing is squeezed.
import { useEffect, type ReactNode } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { Dialog, IconButton, Lockup } from "@nova/ui";
import { fr } from "../../copy/fr";
import { NARROW_QUERY, useMediaQuery } from "../../lib/hooks";
import { useApp } from "../../state/context";
import { AgentPanel } from "../agent/AgentPanel";
import { QuickOpen } from "../files/QuickOpen";
import { HomeView } from "../home/HomeView";
import { MenuIcon, PanelRightIcon } from "../icons";
import { SettingsView } from "../settings/SettingsView";
import { AtelierStatusBar } from "./AtelierStatusBar";
import { Dock } from "./Dock";
import { Explorer } from "./Explorer";
import { Rail } from "./Rail";
import { Workbench } from "./Workbench";

/** Home and settings replace the center; the conversation/mission thread is the agent panel. */
function RouteView({ contextToggle }: { contextToggle: { open: boolean; toggle: () => void } | null }) {
  const route = useApp((state) => state.ui.route);
  if (route === "home") return <HomeView />;
  if (route === "settings") return <SettingsView />;
  return <AgentPanel contextToggle={contextToggle} />;
}

function Main({ children }: { children: ReactNode }) {
  return (
    <main id="nova-main" className="nova-main" aria-label={fr.layout.mainLabel} tabIndex={-1}>
      {children}
    </main>
  );
}

/** Workbench with the dock under it (vertical split), when a folder is open and the dock shown. */
function WorkbenchWithDock() {
  const dockOpen = useApp((state) => state.ui.dockOpen && state.workspace.current !== null);
  return (
    <Group orientation="vertical" id="nova-workbench-split" className="nova-workbench-split">
      <Panel id="workbench-docs" minSize={160}>
        <Workbench />
      </Panel>
      {dockOpen ? (
        <>
          <Separator className="nova-separator nova-separator--horizontal" />
          <Panel id="dock" defaultSize={300} minSize={160} maxSize="60">
            <Dock />
          </Panel>
        </>
      ) : null}
    </Group>
  );
}

function WideWorkshop() {
  const layout = useApp((state) => state.ui.layout);
  const route = useApp((state) => state.ui.route);
  const explorerOpen = useApp((state) => state.ui.explorerOpen);
  const workbenchOpen = useApp((state) => state.ui.workbenchOpen);
  const agentOpen = useApp((state) => state.ui.agentOpen);
  const setUi = useApp((state) => state.setUi);
  const converse = layout === "converse";
  const contextToggle = converse ? { open: workbenchOpen, toggle: () => setUi({ workbenchOpen: !workbenchOpen }) } : null;
  const agentVisible = converse ? route === "chat" : agentOpen;

  return (
    <div className="nova-shell" data-layout={layout}>
      <div className="nova-shell__body">
        <Rail />
        {/* One group per layout: panels keep their own ids, so each disposition keeps its sizes. */}
        <Group orientation="horizontal" className="nova-workshop" id={`nova-workshop-${layout}`} key={layout}>
          {explorerOpen ? (
            <>
              <Panel id="explorer" defaultSize={272} minSize={200} maxSize={420} groupResizeBehavior="preserve-pixel-size">
                <Explorer />
              </Panel>
              <Separator className="nova-separator" />
            </>
          ) : null}
          {converse ? (
            <>
              <Panel id="center" minSize={380}>
                <Main>
                  <RouteView contextToggle={contextToggle} />
                </Main>
              </Panel>
              {workbenchOpen ? (
                <>
                  <Separator className="nova-separator" />
                  <Panel id="workbench" defaultSize={380} minSize={260} maxSize={960} groupResizeBehavior="preserve-pixel-size">
                    <aside className="nova-zone nova-zone--context" aria-label={fr.atelier.shell.workbenchLabel}>
                      <WorkbenchWithDock />
                    </aside>
                  </Panel>
                </>
              ) : null}
            </>
          ) : (
            <>
              <Panel id="center" minSize={480}>
                <Main>{route === "chat" ? <WorkbenchWithDock /> : <RouteView contextToggle={null} />}</Main>
              </Panel>
              {agentOpen ? (
                <>
                  <Separator className="nova-separator" />
                  <Panel id="agent" defaultSize={380} minSize={320} maxSize={560} groupResizeBehavior="preserve-pixel-size">
                    <aside className="nova-zone nova-zone--agent" aria-label={fr.atelier.shell.agentLabel}>
                      <AgentPanel contextToggle={null} />
                    </aside>
                  </Panel>
                </>
              ) : null}
            </>
          )}
        </Group>
      </div>
      <AtelierStatusBar agentVisible={agentVisible} />
    </div>
  );
}

function NarrowWorkshop() {
  const navOpen = useApp((state) => state.ui.navOpen);
  const overlayOpen = useApp((state) => state.ui.contextOverlayOpen);
  const setUi = useApp((state) => state.setUi);
  const route = useApp((state) => state.ui.route);
  return (
    <div className="nova-narrow">
      <header className="nova-topbar">
        <IconButton
          aria-label={fr.nav.openDrawer}
          aria-expanded={navOpen}
          icon={<MenuIcon />}
          onClick={() => setUi({ navOpen: true })}
        />
        <Lockup height={20} />
        <IconButton
          aria-label={fr.atelier.shell.narrowAgent}
          aria-expanded={overlayOpen}
          icon={<PanelRightIcon />}
          onClick={() => setUi({ contextOverlayOpen: !overlayOpen })}
        />
      </header>
      <Main>
        <RouteView contextToggle={null} />
      </Main>
      <AtelierStatusBar agentVisible={route === "chat"} />
      <Dialog
        open={navOpen}
        onClose={() => setUi({ navOpen: false })}
        title={fr.nav.drawerTitle}
        className="nova-drawer nova-drawer--left"
      >
        <div className="nova-drawer__rail">
          <Rail />
          <Explorer />
        </div>
      </Dialog>
      <Dialog
        open={overlayOpen}
        onClose={() => setUi({ contextOverlayOpen: false })}
        title={fr.atelier.shell.workbenchLabel}
        closeLabel={fr.context.close}
        className="nova-drawer nova-drawer--right"
      >
        <aside aria-label={fr.atelier.shell.workbenchLabel} className="nova-zone nova-zone--context">
          <WorkbenchWithDock />
        </aside>
      </Dialog>
    </div>
  );
}

export function Workshop() {
  const narrow = useMediaQuery(NARROW_QUERY);
  const quickOpen = useApp((state) => state.ui.quickOpen);
  const hasWorkspace = useApp((state) => state.workspace.current !== null);
  const setUi = useApp((state) => state.setUi);
  // The store routes « open this document / terminal » to the overlay only when it knows.
  useEffect(() => setUi({ narrow }), [narrow, setUi]);
  return (
    <>
      {narrow ? <NarrowWorkshop /> : <WideWorkshop />}
      {hasWorkspace ? <QuickOpen open={quickOpen} onClose={() => setUi({ quickOpen: false })} /> : null}
    </>
  );
}
