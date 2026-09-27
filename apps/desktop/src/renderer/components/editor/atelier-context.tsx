// Store and client of the atelier components (editor, tree, quick open, project search).
// The lead passes either the standalone `createAtelierStore` store or the app store once it
// includes both slices: any store whose state extends `AtelierState` fits.
import { createContext, use, type ReactNode } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import type { AtelierState } from "../../state/editor-slice";
import type { AtelierClient } from "../../state/workspace-slice";

interface AtelierContextValue {
  store: StoreApi<AtelierState>;
  client: AtelierClient;
}

const AtelierContext = createContext<AtelierContextValue | null>(null);

export function AtelierProvider<S extends AtelierState>({
  store,
  client,
  children,
}: {
  store: StoreApi<S>;
  client: AtelierClient;
  children: ReactNode;
}) {
  return <AtelierContext value={{ store: store as unknown as StoreApi<AtelierState>, client }}>{children}</AtelierContext>;
}

function useAtelierContext(): AtelierContextValue {
  const value = use(AtelierContext);
  if (!value) throw new Error("AtelierProvider is missing");
  return value;
}

/** Subscribes to a slice of the atelier state; keep selectors returning stable values. */
export function useAtelier<T>(selector: (state: AtelierState) => T): T {
  return useStore(useAtelierContext().store, selector);
}

export function useAtelierStore(): StoreApi<AtelierState> {
  return useAtelierContext().store;
}

export function useAtelierClient(): AtelierClient {
  return useAtelierContext().client;
}
