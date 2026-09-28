import { describe, expect, it } from "vitest";
import { NovaIpcError, type DesktopEvent, type DesktopState } from "@nova/shared";
import { createDesktopStore, type DesktopClient } from "./desktop-slice";

const STATE: DesktopState = {
  trayAvailable: true,
  keepRunningOnClose: true,
  activity: { runningMissions: 1, waitingApprovals: 0, runningTerminals: 0, runningProcesses: 0, activeSchedules: 0, nextScheduledAt: null },
  unreadable: [],
};

function client(state: () => Promise<DesktopState>): { client: DesktopClient; emit: (event: DesktopEvent) => void; unsubscribed: () => boolean } {
  let listener: ((event: DesktopEvent) => void) | null = null;
  let unsubscribed = false;
  return {
    client: {
      desktop: {
        state,
        onEvent: (next) => {
          listener = next;
          return () => {
            unsubscribed = true;
          };
        },
      },
      autopilot: { classify: () => Promise.reject(new Error("not used")) },
    },
    emit: (event) => listener?.(event),
    unsubscribed: () => unsubscribed,
  };
}

describe("desktop slice", () => {
  it("mirrors main's state and follows its events", async () => {
    const fake = client(() => Promise.resolve(STATE));
    const store = createDesktopStore(fake.client);
    const stop = store.getState().start();
    await Promise.resolve();
    await Promise.resolve();
    expect(store.getState()).toMatchObject({ availability: "available", state: STATE });
    const next = { ...STATE, activity: { ...STATE.activity, runningMissions: 0 } };
    fake.emit({ type: "desktop.state", state: next });
    expect(store.getState().state).toEqual(next);
    stop();
    expect(fake.unsubscribed()).toBe(true);
  });

  it("is `unavailable` while main does not serve the group (no control is shown then)", async () => {
    const store = createDesktopStore(client(() => Promise.reject(new NovaIpcError({ code: "unavailable", message: "not wired" }))).client);
    store.getState().start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.getState().availability).toBe("unavailable");
    expect(store.getState().state).toBeNull();
  });
});
