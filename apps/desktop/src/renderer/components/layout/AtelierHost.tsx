// Binds the lanes that keep their own stores to the app store: the editor/files atelier store
// (explorer + editor slices), the terminal store and the MessagePort registry. The app store owns
// which workspace is open; this host forwards it, and routes reveal requests to the editor.
import { createContext, use, useEffect, useState, type ReactNode } from "react";
import { createNovaPortRegistry, type NovaPortRegistry } from "@nova/shared";
import { useAppStore, useClient } from "../../state/context";
import { createAtelierStore, startAtelierSync, type AtelierStore } from "../../state/editor-slice";
import { createTerminalStore, type TerminalStore } from "../../state/terminal-slice";
import { AtelierProvider } from "../editor/atelier-context";

export interface ShellServices {
  atelier: AtelierStore;
  terminal: TerminalStore;
  /** null until mounted (the registry listens on `window`). */
  ports: NovaPortRegistry | null;
}

const ShellServicesContext = createContext<ShellServices | null>(null);

export function useShellServices(): ShellServices {
  const value = use(ShellServicesContext);
  if (!value) throw new Error("AtelierHost is missing");
  return value;
}

export function AtelierHost({ children }: { children: ReactNode }) {
  const client = useClient();
  const appStore = useAppStore();
  const [stores] = useState(() => ({ atelier: createAtelierStore(client), terminal: createTerminalStore() }));
  const [ports, setPorts] = useState<NovaPortRegistry | null>(null);

  useEffect(() => {
    const registry = createNovaPortRegistry(window);
    setPorts(registry);
    return () => registry.dispose();
  }, []);

  useEffect(() => startAtelierSync(stores.atelier, client), [stores, client]);

  // The open workspace drives the tree and the editor session.
  useEffect(() => {
    const bind = (id: string | null) => {
      stores.atelier
        .getState()
        .explorer.bind(id)
        // A failed listing shows in the tree itself; nothing to report here.
        .catch(() => undefined);
    };
    bind(appStore.getState().workspace.current?.id ?? null);
    return appStore.subscribe((state, previous) => {
      const id = state.workspace.current?.id ?? null;
      if (id !== (previous.workspace.current?.id ?? null)) bind(id);
    });
  }, [appStore, stores]);

  // Citation chips, diff "open", Nomi: `revealFile` requests become editor opens (user-initiated).
  useEffect(
    () =>
      appStore.subscribe((state) => {
        const reveal = state.ui.reveal;
        if (!reveal) return;
        state.consumeReveal(reveal.nonce);
        const options = reveal.line === null ? {} : { line: reveal.line };
        stores.atelier
          .getState()
          .editor.openFile(reveal.path, options)
          .catch(() => undefined);
      }),
    [appStore, stores],
  );

  // Terminal requests (Nomi "watch command", explain error) select the session in the dock.
  useEffect(
    () =>
      appStore.subscribe((state, previous) => {
        const request = state.ui.terminalRequest;
        if (!request || request === previous.ui.terminalRequest) return;
        if (request.sessionId) stores.terminal.getState().select(request.sessionId);
      }),
    [appStore, stores],
  );

  return (
    <AtelierProvider store={stores.atelier} client={client}>
      <ShellServicesContext value={{ ...stores, ports }}>{children}</ShellServicesContext>
    </AtelierProvider>
  );
}
