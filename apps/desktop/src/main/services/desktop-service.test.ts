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
        runningTerminals: async () => 2,
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
    });
    expect((await service.snapshot()).missions.map((item) => item.id)).toEqual(["a", "b"]);
  });

  it("counts 0 for a feature that is not wired, and lists a failing source as unreadable", async () => {
    const { service, warnings } = setup({ runningTerminals: () => Promise.reject(new Error("pty-host down")) }, { tray: false });
    const snapshot = await service.snapshot();
    expect(activityCount(snapshot.state.activity)).toBe(0);
    expect(snapshot.state.trayAvailable).toBe(false);
    expect(snapshot.unreadable).toEqual(["terminals"]);
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
});
