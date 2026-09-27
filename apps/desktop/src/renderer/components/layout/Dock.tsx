// Dock (VISUAL.md §4.5): the terminal lane's panel under the workbench. Only with an open folder.
import { IconButton, Tabs, tabPanelProps, useToast } from "@nova/ui";
import { fr } from "../../copy/fr";
import { errorToast } from "../../lib/errors";
import { useApp, useAppStore, useClient } from "../../state/context";
import { NEW_CONVERSATION } from "../../state/store";
import { CloseIcon } from "../icons";
import { TerminalPanel, type TerminalExplainRequest } from "../terminal/TerminalPanel";
import { useShellServices } from "./AtelierHost";

const copy = fr.atelier.shell;
const ID_PREFIX = "dock";

/** The question put in the draft for "Expliquer": the command context and its (redacted) output. */
export function explainPrompt(request: TerminalExplainRequest): string {
  const status = request.exitCode === null ? "" : ` (code ${request.exitCode})`;
  const intro = request.source === "failure" ? copy.explainFailure(request.shell, status) : copy.explainSelection(request.shell);
  return `${intro}\n\n\`\`\`\n${request.text}\n\`\`\``;
}

export function Dock() {
  const client = useClient();
  const workspace = useApp((state) => state.workspace.current);
  const setUi = useApp((state) => state.setUi);
  const appStore = useAppStore();
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
        <TerminalPanel
          api={client.terminal}
          ports={ports}
          store={terminal}
          workspaceId={workspace.id}
          onOpenLink={(uri) => {
            client.app.openExternal({ url: uri }).catch((error: unknown) => toast.show(errorToast(error, copy.terminal)));
          }}
          // N3: the redacted output goes into the conversation draft; nothing is sent without the user.
          onExplain={(request) => {
            const state = appStore.getState();
            const current = state.drafts[state.activeId ?? NEW_CONVERSATION]?.text ?? "";
            const block = explainPrompt(request);
            state.setDraft(state.activeId, current ? `${current}\n\n${block}` : block);
            state.setWorkMode("discuss");
            setUi({ route: "chat", agentOpen: true });
          }}
        />
      </div>
    </section>
  );
}
