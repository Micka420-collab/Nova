import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openNovaStore } from "../nova-store";
import type { NovaStore } from "../types";
import { createSignalRepo } from "./signals";
import { createSuggestionRepo } from "./suggestions";

let store: NovaStore;
let clock: number;
const now = (): number => (clock += 1);

beforeEach(() => {
  clock = 1000;
  store = openNovaStore(":memory:");
});
afterEach(() => {
  store.close();
});

function newSignal(sourceRef = "test_failed:tool_call:c1") {
  return createSignalRepo(store.db, now).insert({
    workspaceId: null,
    missionId: null,
    kind: "test_failed",
    sourceRef,
    evidence: { excerpt: "1 failed", path: null },
  });
}

describe("signal repo (companion reads)", () => {
  it("finds a fact by source, lists recent first, and updates its state", () => {
    const signals = createSignalRepo(store.db, now);
    const first = newSignal("a");
    const second = newSignal("b");
    expect(signals.findBySource("test_failed", "a")?.id).toBe(first.id);
    expect(signals.findBySource("process_crashed", "a")).toBeNull();
    expect(signals.listRecent(10).map((s) => s.id)).toEqual([second.id, first.id]);
    expect(signals.setState(first.id, "ignored")).toBe(true);
    expect(signals.get(first.id)?.state).toBe("ignored");
    expect(signals.listNew().map((s) => s.id)).toEqual([second.id]);
    expect(signals.setState("missing", "seen")).toBe(false);
  });
});

describe("suggestion repo", () => {
  it("records a suggestion against its signal, then the user's answer", () => {
    const signal = newSignal();
    const suggestions = createSuggestionRepo(store.db, now);
    const action = { type: "explain_error", sourceRef: { kind: "terminal", sessionId: "s" } };
    const created = suggestions.insert({ signalId: signal.id, text: "Un test échoue.", action });
    expect(created).toMatchObject({ signalId: signal.id, status: "proposed", action, decidedAt: null });
    expect(suggestions.lastCreatedAt()).toBe(created.createdAt);
    expect(suggestions.listProposed().map((s) => s.id)).toEqual([created.id]);
    expect(suggestions.latestForSignal(signal.id)?.id).toBe(created.id);

    const decided = suggestions.decide(created.id, "dismissed");
    expect(decided).toMatchObject({ status: "dismissed" });
    expect(decided?.decidedAt).toBeGreaterThan(created.createdAt);
    expect(suggestions.listProposed()).toEqual([]);
    expect(suggestions.decide("missing", "accepted")).toBeNull();
  });

  it("refuses a suggestion without a signal (no suggestion without a recorded fact)", () => {
    const suggestions = createSuggestionRepo(store.db, now);
    expect(() => suggestions.insert({ signalId: "missing", text: "x", action: null })).toThrow(/FOREIGN KEY/);
    expect(suggestions.lastCreatedAt()).toBeNull();
  });
});
