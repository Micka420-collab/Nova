// J2-B groups before their lane is wired: every call is refused with `unavailable` (the renderer
// shows no control for a group that answers so). The integrator replaces one group at a time in
// index.ts with the lane's service (`harness: { ...unavailableHarnessApi(), processes: … }`).
import { HARNESS_GROUPS, type HarnessGroup } from "@nova/shared";
import type { MainApi } from "../api";
import { ServiceError } from "../service-error";

export type HarnessApi = Pick<MainApi, HarnessGroup>;

/** Method names of each J2-B group (without push subscriptions, which main never serves by IPC). */
const METHODS: { readonly [G in HarnessGroup]: readonly (keyof HarnessApi[G])[] } = {
  processes: ["list", "output", "stop"],
  context: ["usage", "compact", "decide", "list", "handoff"],
  skills: ["list", "get", "preview", "install", "uninstall", "setEnabled"],
  submissions: ["tree", "integrate", "discard"],
  schedules: ["list", "create", "update", "setPaused", "remove", "runs"],
  desktop: ["state"],
  autopilot: ["classify"],
  timeline: ["search", "fork"],
};

export function unavailableHarnessApi(): HarnessApi {
  const group = (name: HarnessGroup): Record<string, () => Promise<never>> =>
    Object.fromEntries(
      METHODS[name].map((method) => [
        String(method),
        () => Promise.reject(new ServiceError("unavailable", `${name}.${String(method)} is not available yet`)),
      ]),
    );
  return Object.fromEntries(HARNESS_GROUPS.map((name) => [name, group(name)])) as unknown as HarnessApi;
}

export const HARNESS_METHODS = METHODS;
