// L8 timeline store: availability learned once, stale answers dropped, every action ends in a
// visible state (results, empty, error, ready mission), scope resolution.
import { describe, expect, it, vi } from "vitest";
import { NovaIpcError, type MissionForkRequest, type MissionPlanResult, type TimelineHit, type TimelineSearchRequest } from "@nova/shared";
import { createTimelineStore, effectiveScope, forkKey, type TimelineClient } from "./timeline-slice";

const M = "00000000-0000-4000-8000-0000000000a1";
const W = "00000000-0000-4000-8000-0000000000b1";
const hit = (seq: number): TimelineHit => ({ missionId: M, missionTitle: "Panier", seq, type: "mission.failed", at: seq, snippet: "panier" });

function client(overrides: Partial<TimelineClient["timeline"]> = {}): TimelineClient & { searches: TimelineSearchRequest[] } {
  const searches: TimelineSearchRequest[] = [];
  return {
    searches,
    timeline: {
      search: vi.fn<TimelineClient["timeline"]["search"]>(async (request: TimelineSearchRequest) => {
        searches.push(request);
        return [hit(3)];
      }),
      fork: vi.fn<TimelineClient["timeline"]["fork"]>(async (_request: MissionForkRequest): Promise<MissionPlanResult> => {
        throw new NovaIpcError({ code: "internal", message: "unused" });
      }),
      ...overrides,
    },
  };
}

describe("timeline store", () => {
  it("probes once and hides the group when main answers unavailable", async () => {
    const api = client({ search: vi.fn<TimelineClient["timeline"]["search"]>(async () => Promise.reject(new NovaIpcError({ code: "unavailable", message: "no" }))) });
    const store = createTimelineStore(api);
    await Promise.all([store.getState().probe(), store.getState().probe()]);
    expect(store.getState().availability).toBe("unavailable");
    expect(api.timeline.search).toHaveBeenCalledTimes(1);
    await store.getState().probe();
    expect(api.timeline.search).toHaveBeenCalledTimes(1);
  });

  it("searches with the resolved scope and keeps only the latest answer", async () => {
    let release: (value: TimelineHit[]) => void = () => {};
    const slow = new Promise<TimelineHit[]>((resolve) => (release = resolve));
    const calls: TimelineSearchRequest[] = [];
    const api = client({
      search: vi.fn<TimelineClient["timeline"]["search"]>(async (request: TimelineSearchRequest) => {
        calls.push(request);
        return calls.length === 1 ? slow : [hit(9)];
      }),
    });
    const store = createTimelineStore(api);
    const first = store.getState().runSearch({ query: "vieux", scope: "mission", workspaceId: W, missionId: M });
    await store.getState().runSearch({ query: " panier ", scope: "workspace", workspaceId: W, missionId: M });
    release([hit(1)]);
    await first;
    expect(calls).toEqual([
      { query: "vieux", workspaceId: W, missionId: M, limit: 50 },
      { query: "panier", workspaceId: W, missionId: null, limit: 50 },
    ]);
    expect(store.getState().search).toMatchObject({ query: "panier", status: "done", hits: [hit(9)] });
    expect(store.getState().availability).toBe("available");
  });

  it("an empty query clears; a failure is shown, not thrown", async () => {
    const store = createTimelineStore(client({ search: vi.fn<TimelineClient["timeline"]["search"]>(async () => Promise.reject(new NovaIpcError({ code: "internal", message: "boom" }))) }));
    await store.getState().runSearch({ query: "   ", scope: "all", workspaceId: null, missionId: null });
    expect(store.getState().search.status).toBe("idle");
    await store.getState().runSearch({ query: "x", scope: "all", workspaceId: null, missionId: null });
    expect(store.getState().search).toMatchObject({ status: "error", error: { code: "internal" } });
  });

  it("keeps each fork's outcome per event and never asks twice at once", async () => {
    let release: (value: MissionPlanResult) => void = () => {};
    const pending = new Promise<MissionPlanResult>((resolve) => (release = resolve));
    const api = client({ fork: vi.fn<TimelineClient["timeline"]["fork"]>(async () => pending) });
    const store = createTimelineStore(api);
    const request = { missionId: M, atSeq: 4, goal: null, modelId: null };
    const first = store.getState().fork(request);
    expect(await store.getState().fork(request)).toBeNull();
    expect(store.getState().forks[forkKey(M, 4)]).toEqual({ status: "preparing" });
    const result = { mission: { id: "n", title: "Panier" } } as unknown as MissionPlanResult;
    release(result);
    expect(await first).toBe(result);
    expect(store.getState().forks[forkKey(M, 4)]).toEqual({ status: "ready", result });
    expect(api.timeline.fork).toHaveBeenCalledTimes(1);
    store.getState().dismissFork(M, 4);
    expect(store.getState().forks).toEqual({});
  });

  it("records a refused fork as an error", async () => {
    const store = createTimelineStore(client({ fork: vi.fn<TimelineClient["timeline"]["fork"]>(async () => Promise.reject(new NovaIpcError({ code: "invalid_request", message: "seq" }))) }));
    expect(await store.getState().fork({ missionId: M, atSeq: 99, goal: null, modelId: null })).toBeNull();
    expect(store.getState().forks[forkKey(M, 99)]).toMatchObject({ status: "error", error: { code: "invalid_request" } });
  });

  it("widens a scope that has no target", () => {
    expect(effectiveScope({ scope: "mission", workspaceId: W, missionId: null })).toBe("workspace");
    expect(effectiveScope({ scope: "mission", workspaceId: null, missionId: null })).toBe("all");
    expect(effectiveScope({ scope: "workspace", workspaceId: W, missionId: M })).toBe("workspace");
    expect(effectiveScope({ scope: "all", workspaceId: W, missionId: M })).toBe("all");
  });
});
