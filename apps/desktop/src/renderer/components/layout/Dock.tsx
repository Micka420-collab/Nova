// Dock (VISUAL.md §4.5): the terminal lane's panel under the workbench. Only with an open folder.
import { useEffect } from "react";
import { useStore } from "zustand";
import { IconButton, Tabs, tabPanelProps, useToast } from "@nova/ui";
import { fr } from "../../copy/fr";
import { useApp, useAppStore, useClient } from "../../state/context";
import { useHarnessStores } from "../../state/harness-stores";
import { interactiveAgentSessions } from "../../state/processes-slice";
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
  const { processes } = useHarnessStores();
  const running = useStore(processes, (state) => state.processes);
  const workspaceId = workspace?.id ?? null;
  // J2-B L1: « Prendre la main » only on an agent session that hosts a running background program.
  useEffect(() => {
    if (!workspaceId) return undefined;
    const scope = { workspaceId, missionId: null };
    client.processes.list(scope).then(
      (list) => processes.getState().setProcesses(scope, list),
      // `unavailable` or a failure: no process is known, so no takeover is offered.
      () => undefined,
    );
    return client.processes.onEvent((event) => processes.getState().applyEvent(event));
  }, [client, processes, workspaceId]);
  if (!workspace) return null;
  const interactive = interactiveAgentSessions(running);
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
          canTakeOver={(session) => interactive.has(session.id)}
          onOpenLink={(uri) => {
            // Main opens trusted hosts only: say so, with the real address, instead of a bare « Terminal ».
            client.app.openExternal({ url: uri }).catch(() => toast.show({ tone: "warning", title: fr.chat.linkRefused, description: uri }));
          }}
          // N3: the redacted output goes into the conversation draft; nothing is sent without the user.
          onExplain={(request) => appStore.getState().draftIntoChat(explainPrompt(request))}
        />
      </div>
    </section>
  );
}
