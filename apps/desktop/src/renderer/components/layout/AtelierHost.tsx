// Binds the lanes that keep their own stores to the app store: the editor/files atelier store
// (explorer + editor slices), the terminal store, Nomi's companion store and the MessagePort
// registry. The app store owns which workspace is open; this host forwards it, and routes reveal
// requests to the editor and companion navigations to the shell.
import { createContext, use, useEffect, useState, type ReactNode } from "react";
import { createNovaPortRegistry, type NovaPortRegistry } from "@nova/shared";
import { useAppStore, useClient } from "../../state/context";
import { createAtelierStore, ipcSessionStore, startAtelierSync, type AtelierStore } from "../../state/editor-slice";
import { connectCompanion, createCompanionStore, type CompanionStore } from "../../state/companion-slice";
import { createTerminalStore, type TerminalStore } from "../../state/terminal-slice";
import { CompanionProvider } from "../companion/CompanionContext";
import { AtelierProvider } from "../editor/atelier-context";

export interface ShellServices {
  atelier: AtelierStore;
  terminal: TerminalStore;
  companion: CompanionStore;
  /** One registry per page (terminal ports arrive through `window`). */
  ports: NovaPortRegistry;
}

const ShellServicesContext = createContext<ShellServices | null>(null);

let pageRegistry: NovaPortRegistry | null = null;

/**
 * The page's MessagePort registry, created on first use and kept for the page's lifetime: ports
 * posted by the preload must find their registry even across remounts (StrictMode, tests).
 */
function pagePortRegistry(): NovaPortRegistry {
  pageRegistry ??= createNovaPortRegistry(window);
  return pageRegistry;
}

/** The shell services when rendered inside AtelierHost, else null (docks rendered on their own). */
export function useOptionalShellServices(): ShellServices | null {
  return use(ShellServicesContext);
}

export function useShellServices(): ShellServices {
  const value = use(ShellServicesContext);
  if (!value) throw new Error("AtelierHost is missing");
  return value;
}

export function AtelierHost({ children }: { children: ReactNode }) {
  const client = useClient();
  const appStore = useAppStore();
  const [sessions] = useState(() => ipcSessionStore(client));
  const [stores] = useState(() => ({
    atelier: createAtelierStore(client, { sessions }),
    terminal: createTerminalStore(),
    companion: createCompanionStore({
      client,
      navigate: (action) => appStore.getState().navigateCompanion(action),
      openSettings: () => appStore.getState().openSettings("companion"),
      watch: (sessionId) => client.companion.watch({ sessionId }),
      setQuiet: (until) => client.companion.setQuiet({ until }),
    }),
  }));
  const ports = pagePortRegistry();

  useEffect(() => startAtelierSync(stores.atelier, client, sessions), [stores, client, sessions]);
  useEffect(() => connectCompanion(stores.companion, client), [stores, client]);

  // The open workspace drives the tree and the editor session.
  useEffect(() => {
    const bind = (id: string | null) => {
      stores.atelier
        .getState()
        .explorer.bind(id)
        // A failed listing shows in the tree itself; nothing to report here.
        .catch(() => undefined);
      // Suggestions and mission facts of this folder (hydrate keeps unknown as empty on failure).
      void stores.companion.getState().hydrate(id);
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
      <CompanionProvider store={stores.companion}>
        <ShellServicesContext value={{ ...stores, ports }}>{children}</ShellServicesContext>
      </CompanionProvider>
    </AtelierProvider>
  );
}
