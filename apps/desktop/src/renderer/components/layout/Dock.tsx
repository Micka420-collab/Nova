// Dock (VISUAL.md §4.5): the terminal lane's panel under the workbench. Only with an open folder.
import { Callout, IconButton, Tabs, tabPanelProps, useToast } from "@nova/ui";
import { fr } from "../../copy/fr";
import { errorToast } from "../../lib/errors";
import { useApp, useClient } from "../../state/context";
import { CloseIcon } from "../icons";
import { TerminalPanel } from "../terminal/TerminalPanel";
import { useShellServices } from "./AtelierHost";

const copy = fr.atelier.shell;
const ID_PREFIX = "dock";

export function Dock() {
  const client = useClient();
  const workspace = useApp((state) => state.workspace.current);
  const setUi = useApp((state) => state.setUi);
  const { terminal, ports } = useShellServices();
  const toast = useToast();
  if (!workspace) return null;
  return (
    <section className="nova-dock-panel" aria-label={copy.dockLabel}>
      <div className="nova-dock-panel__bar">
        <Tabs
          label={copy.dockTabs}
          idPrefix={ID_PREFIX}
          items={[{ key: "terminal", label: copy.terminal }]}
          activeKey="terminal"
          onSelect={() => undefined}
        />
        <IconButton size="sm" aria-label={fr.app.close} icon={<CloseIcon size={14} />} onClick={() => setUi({ dockOpen: false })} />
      </div>
      <div {...tabPanelProps(ID_PREFIX, "terminal")} className="nova-dock-panel__body">
        {ports ? (
          <TerminalPanel
            api={client.terminal}
            ports={ports}
            store={terminal}
            workspaceId={workspace.id}
            onOpenLink={(uri) => {
              client.app.openExternal({ url: uri }).catch((error: unknown) => toast.show(errorToast(error, copy.terminal)));
            }}
          />
        ) : (
          <Callout tone="info">{copy.placeholderTerminal}</Callout>
        )}
      </div>
    </section>
  );
}
