// One timeline store per client (the app has one client), created on first use. Lets the L8
// search and event actions share their state wherever they are mounted.
import { useEffect } from "react";
import { useStore } from "zustand";
import type { NovaApi } from "@nova/shared";
import { useClient } from "../../state/context";
import { createTimelineStore, type TimelineSlice, type TimelineStore } from "../../state/timeline-slice";

const stores = new WeakMap<NovaApi, TimelineStore>();

export function timelineStoreFor(client: NovaApi): TimelineStore {
  let store = stores.get(client);
  if (!store) {
    store = createTimelineStore(client);
    stores.set(client, store);
  }
  return store;
}

export function useTimelineStore(): TimelineStore {
  return timelineStoreFor(useClient());
}

export function useTimelineSlice<T>(selector: (state: TimelineSlice) => T): T {
  return useStore(useTimelineStore(), selector);
}

/** True once main is known to serve `timeline.*` (probes once); controls render only then. */
export function useTimelineAvailable(): boolean {
  const store = useTimelineStore();
  const availability = useStore(store, (state) => state.availability);
  useEffect(() => {
    if (availability === "unknown") void store.getState().probe();
  }, [availability, store]);
  return availability === "available";
}
