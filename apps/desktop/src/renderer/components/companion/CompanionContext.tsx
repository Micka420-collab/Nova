// Access to Nomi's store. Optional on purpose: without a provider the dock keeps its J1 behavior
// (status + settings), so the shell renders the same until the companion is wired.
import { createContext, use, useSyncExternalStore, type ReactNode } from "react";
import type { CompanionState, CompanionStore } from "../../state/companion-slice";

const CompanionContext = createContext<CompanionStore | null>(null);

export function CompanionProvider({ store, children }: { store: CompanionStore; children: ReactNode }) {
  return <CompanionContext value={store}>{children}</CompanionContext>;
}

export function useCompanionStore(): CompanionStore | null {
  return use(CompanionContext);
}

const subscribeNothing = (): (() => void) => () => {};

/** Selects from the companion store, or returns `fallback` without a provider. Keep selections stable. */
export function useCompanion<T>(selector: (state: CompanionState) => T, fallback: T): T {
  const store = useCompanionStore();
  return useSyncExternalStore(store ? store.subscribe : subscribeNothing, () => (store ? selector(store.getState()) : fallback));
}
