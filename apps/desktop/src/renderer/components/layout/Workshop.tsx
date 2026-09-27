// Three-zone workshop: navigation, work area, context. Resizable on wide windows; below 900 px the
// navigation becomes a drawer and the context an overlay, so nothing is squeezed.
import { Group, Panel, Separator } from "react-resizable-panels";
import { Dialog, IconButton, Lockup } from "@nova/ui";
import { fr } from "../../copy/fr";
import { NARROW_QUERY, useMediaQuery } from "../../lib/hooks";
import { useApp } from "../../state/context";
import { ChatView } from "../chat/ChatView";
import { HomeView } from "../home/HomeView";
import { MenuIcon, PanelRightIcon } from "../icons";
import { SettingsView } from "../settings/SettingsView";
import { ContextPanel } from "./ContextPanel";
import { Sidebar } from "./Sidebar";

/** The chat header toggles the context panel on wide windows; the narrow top bar has its own toggle. */
function Center({ narrow }: { narrow: boolean }) {
  const route = useApp((state) => state.ui.route);
  const contextOpen = useApp((state) => state.ui.rightPanelOpen);
  const setUi = useApp((state) => state.setUi);
  const contextToggle = narrow ? null : { open: contextOpen, toggle: () => setUi({ rightPanelOpen: !contextOpen }) };
  return (
    <main id="nova-main" className="nova-main" aria-label={fr.layout.mainLabel} tabIndex={-1}>
      {route === "home" ? <HomeView /> : null}
      {route === "chat" ? <ChatView contextToggle={contextToggle} /> : null}
      {route === "settings" ? <SettingsView /> : null}
    </main>
  );
}

function WideWorkshop() {
  const contextOpen = useApp((state) => state.ui.rightPanelOpen);
  return (
    <Group orientation="horizontal" className="nova-workshop" id="nova-workshop">
      <Panel id="nav" defaultSize={272} minSize={220} maxSize={420} groupResizeBehavior="preserve-pixel-size">
        <nav className="nova-zone nova-zone--nav" aria-label={fr.nav.label}>
          <Sidebar />
        </nav>
      </Panel>
      <Separator className="nova-separator" />
      <Panel id="center" minSize={380}>
        <Center narrow={false} />
      </Panel>
      {contextOpen ? (
        <>
          <Separator className="nova-separator" />
          <Panel id="context" defaultSize={300} minSize={240} maxSize={480} groupResizeBehavior="preserve-pixel-size">
            <aside className="nova-zone nova-zone--context" aria-label={fr.context.title}>
              <ContextPanel />
            </aside>
          </Panel>
        </>
      ) : null}
    </Group>
  );
}

function NarrowWorkshop() {
  const navOpen = useApp((state) => state.ui.navOpen);
  const contextOpen = useApp((state) => state.ui.contextOverlayOpen);
  const setUi = useApp((state) => state.setUi);
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
          aria-label={fr.context.toggle}
          aria-expanded={contextOpen}
          icon={<PanelRightIcon />}
          onClick={() => setUi({ contextOverlayOpen: !contextOpen })}
        />
      </header>
      <Center narrow />
      <Dialog
        open={navOpen}
        onClose={() => setUi({ navOpen: false })}
        title={fr.nav.drawerTitle}
        className="nova-drawer nova-drawer--left"
      >
        <nav aria-label={fr.nav.label} className="nova-zone nova-zone--nav">
          <Sidebar />
        </nav>
      </Dialog>
      <Dialog
        open={contextOpen}
        onClose={() => setUi({ contextOverlayOpen: false })}
        title={fr.context.title}
        closeLabel={fr.context.close}
        className="nova-drawer nova-drawer--right"
      >
        <aside aria-label={fr.context.title} className="nova-zone nova-zone--context">
          <ContextPanel />
        </aside>
      </Dialog>
    </div>
  );
}

export function Workshop() {
  const narrow = useMediaQuery(NARROW_QUERY);
  return narrow ? <NarrowWorkshop /> : <WideWorkshop />;
}
