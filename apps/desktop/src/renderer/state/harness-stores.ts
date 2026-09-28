// J2-B stores that lanes deliver without an owner: one per client (the app has one), created on
// first use. Mission events reach the sub-missions store for the app's lifetime; processes and
// schedules subscribe where they are shown (their components follow `onEvent` themselves).
import type { NovaApi } from "@nova/shared";
import { createProcessesStore, type ProcessesStore } from "./processes-slice";
import { createSchedulesStore, type SchedulesStore } from "./schedules-slice";
import { createSubmissionsStore, type SubmissionsStore } from "./submissions-slice";
import { useClient } from "./context";

interface HarnessStores {
  processes: ProcessesStore;
  submissions: SubmissionsStore;
  schedules: SchedulesStore;
}

const stores = new WeakMap<NovaApi, HarnessStores>();

export function harnessStoresFor(client: NovaApi): HarnessStores {
  let found = stores.get(client);
  if (!found) {
    const submissions = createSubmissionsStore(client);
    // A child's end (and its `submission.updated` on the parent) refreshes the trees on screen.
    client.missions.onEvent((event) => submissions.getState().applyMissionEvent(event));
    found = { processes: createProcessesStore(), submissions, schedules: createSchedulesStore() };
    stores.set(client, found);
  }
  return found;
}

export function useHarnessStores(): HarnessStores {
  return harnessStoresFor(useClient());
}
