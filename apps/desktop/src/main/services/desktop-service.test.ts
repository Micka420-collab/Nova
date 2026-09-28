// L7 desktop state: counts come from the services, bursts of events give one recompute, and only a
// changed state is pushed.
import type { DesktopEvent } from "@nova/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { activityCount, createDesktopService, type ActiveMission, type DesktopActivitySources } from "./desktop-service";

afterEach(() => {
  vi.useRealTimers();
});

const mission = (id: string, state: ActiveMission["state"], title = `Mission ${id}`): ActiveMission => ({ id, title, state });

function setup(sources: DesktopActivitySources, options: { keep?: boolean; tray?: boolean } = {}) {
  const pushed: DesktopEvent[] = [];
  const warnings: string[] = [];
  const service = createDesktopService({
    sources,
    keepRunningOnClose: () => options.keep ?? false,
    trayAvailable: () => options.tray ?? true,
    push: (event) => pushed.push(event),
    debounceMs: 20,
    logger: { info: () => undefined, warn: (msg) => warnings.push(msg), error: (msg) => warnings.push(msg) },
  });
  return { service, pushed, warnings };
}

describe("desktop.state", () => {
  it("counts what really runs, from each service", async () => {
    const { service } = setup(
      {
        missions: async () => [mission("a", "running"), mission("b", "waiting_approval"), mission("c", "succeeded"), mission("d", "suspended")],
        pendingApprovals: async () => 1,
        // Only the user's running sessions are terminals: an agent program is its process, a
        // mission's mirror session runs nothing.
        terminals: async () => [
          { owner: "user", state: "running" },
          { owner: "user", state: "running" },
          { owner: "user", state: "exited" },
          { owner: "agent", state: "running" },
          { owner: "agent", state: "running" },
        ],
        runningProcesses: async () => 3,
        schedules: () => ({ activeCount: 1, nextDueAt: 1_700_000_000_000 }),
      },
      { keep: true },
    );
    expect(await service.api.state()).toEqual({
      trayAvailable: true,
      keepRunningOnClose: true,
      activity: {
        runningMissions: 2,
        waitingApprovals: 1,
        runningTerminals: 2,
        runningProcesses: 3,
        activeSchedules: 1,
        nextScheduledAt: 1_700_000_000_000,
      },
      unreadable: [],
    });
    expect((await service.snapshot()).missions.map((item) => item.id)).toEqual(["a", "b"]);
  });

  it("counts 0 for a feature that is not wired, and lists a failing source as unreadable", async () => {
    const { service, warnings } = setup({ terminals: () => Promise.reject(new Error("pty-host down")) }, { tray: false });
    const snapshot = await service.snapshot();
    expect(activityCount(snapshot.state.activity)).toBe(0);
    expect(snapshot.state.trayAvailable).toBe(false);
    // Carried in the state itself: the renderer and the tray say « inconnu », not 0.
    expect(snapshot.state.unreadable).toEqual(["terminals"]);
    expect(warnings).toEqual(["desktop activity source failed"]);
  });

  it("recomputes once per burst of events and pushes only a changed state", async () => {
    vi.useFakeTimers();
    let running = 0;
    const reads = vi.fn<() => Promise<number>>(async () => running);
    const { service, pushed } = setup({ runningProcesses: reads });
    const changes: number[] = [];
    service.onChange((snapshot) => changes.push(snapshot.state.activity.runningProcesses));

    running = 1;
    service.notify();
    service.notify();
    service.notify();
    await vi.advanceTimersByTimeAsync(25);
    expect(reads).toHaveBeenCalledTimes(1);
    expect(pushed).toHaveLength(1);

    // Same state again: nothing pushed.
    service.notify();
    await vi.advanceTimersByTimeAsync(25);
    expect(pushed).toHaveLength(1);

    running = 0;
    service.notify();
    await vi.advanceTimersByTimeAsync(25);
    expect(pushed.map((event) => event.state.activity.runningProcesses)).toEqual([1, 0]);
    expect(changes).toEqual([1, 0]);

    service.dispose();
    service.notify();
    await vi.advanceTimersByTimeAsync(25);
    expect(pushed).toHaveLength(2);
  });

  it("refreshes the tray when the listed missions change though the counts do not", async () => {
    vi.useFakeTimers();
    let missions = [mission("a", "running", "Corriger le panier")];
    const { service, pushed } = setup({ missions: async () => missions });
    const listed: string[][] = [];
    service.onChange((snapshot) => listed.push(snapshot.missions.map((item) => item.title)));
    service.notify();
    await vi.advanceTimersByTimeAsync(25);
    // A ended, B started in the same burst: still one running mission.
    missions = [mission("a", "succeeded", "Corriger le panier"), mission("b", "running", "Écrire les tests")];
    service.notify();
    await vi.advanceTimersByTimeAsync(25);
    expect(listed).toEqual([["Corriger le panier"], ["Écrire les tests"]]);
    // The renderer only shows counts: pushed once.
    expect(pushed).toHaveLength(1);
  });
});
