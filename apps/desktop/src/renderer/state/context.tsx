import { createContext, use, type ReactNode } from "react";
import { useStore } from "zustand";
import type { NovaApi } from "@nova/shared";
import type { AppState, AppStore } from "./store";

interface AppContextValue {
  store: AppStore;
  client: NovaApi;
}

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ store, client, children }: AppContextValue & { children: ReactNode }) {
  return <AppContext value={{ store, client }}>{children}</AppContext>;
}

function useAppContext(): AppContextValue {
  const value = use(AppContext);
  if (!value) throw new Error("AppProvider is missing");
  return value;
}

/** Subscribes to a slice of the app state; keep selectors returning stable values. */
export function useApp<T>(selector: (state: AppState) => T): T {
  return useStore(useAppContext().store, selector);
}

export function useAppStore(): AppStore {
  return useAppContext().store;
}

export function useClient(): NovaApi {
  return useAppContext().client;
}
