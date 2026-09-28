// One context store per client (the app has one client): created on first use, subscribed to
// `context.onEvent` for the app's lifetime. Lets the L2 panels work wherever they are mounted.
import { useStore } from "zustand";
import type { NovaApi } from "@nova/shared";
import { createContextStore, type ContextSlice, type ContextStore } from "../../state/context-slice";
import { useClient } from "../../state/context";

const stores = new WeakMap<NovaApi, ContextStore>();

export function contextStoreFor(client: NovaApi): ContextStore {
  let store = stores.get(client);
  if (!store) {
    store = createContextStore(client);
    stores.set(client, store);
  }
  return store;
}

export function useContextStore(): ContextStore {
  return contextStoreFor(useClient());
}

export function useContextSlice<T>(selector: (state: ContextSlice) => T): T {
  return useStore(useContextStore(), selector);
}
