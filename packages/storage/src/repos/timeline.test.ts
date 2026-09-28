// L8 timeline search repo: user text is data (never FTS syntax), terms split like the index,
// accents and prefixes, scope by workspace and mission, newest first, payload for the excerpt.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openNovaStore } from "../nova-store";
import type { NovaStore } from "../types";
import { createMissionRepo, type MissionRepo } from "./missions";
import { createTimelineSearchRepo, queryTerms, toFtsQuery, TIMELINE_QUERY_MAX_TERMS } from "./timeline";
import { createWorkspaceRepo } from "./workspaces";

let store: NovaStore;
let clock: number;
let missions: MissionRepo;
const now = (): number => (clock += 1);

function workspace(root: string): string {
  return createWorkspaceRepo(store.db, now).upsertByRootPath({ rootPath: root, name: root }).id;
}

function mission(workspaceId: string, title: string): string {
  return missions.create({
    workspaceId,
    conversationId: null,
    title,
    goal: title,
    mode: "fix",
    modelId: "acme/m",
    contract: { profile: "assisted", isolationLevel: "L0", allowedOperations: ["read"], allowedHosts: [], maxDurationMs: 60_000, budgetUsd: 0.5 },
  }).id;
}

beforeEach(() => {
  clock = 1_000;
  store = openNovaStore(":memory:");
  missions = createMissionRepo(store.db, now);
});
afterEach(() => store.close());

describe("queryTerms / toFtsQuery", () => {
  it("splits on punctuation like the tokenizer and drops punctuation-only terms", () => {
    expect(queryTerms("panier.total()  —  (")).toEqual(["panier", "total"]);
    expect(toFtsQuery("réduction, panier")).toBe('"réduction" "panier"*');
    // Before: '"("' was sent as an empty phrase and the whole query matched nothing.
    expect(toFtsQuery("panier (")).toBe('"panier"*');
    expect(toFtsQuery(' " * : ( ) ')).toBeNull();
  });

  it("caps the number of terms", () => {
    const query = Array.from({ length: 40 }, (_, index) => `mot${index}`).join(" ");
    expect(queryTerms(query)).toHaveLength(TIMELINE_QUERY_MAX_TERMS);
  });
});

describe("createTimelineSearchRepo", () => {
  it("matches accents, prefixes and every term; scoped; newest first; with the payload", () => {
    const search = createTimelineSearchRepo(store.db);
    const wsA = workspace("/a");
    const wsB = workspace("/b");
    const cart = mission(wsA, "Panier");
    const bill = mission(wsB, "Facture");
    missions.appendEvent(cart, "mission.failed", { reason: "acceptance_failed", detail: "Le test du panier échoue" });
    missions.appendEvent(cart, "mission.succeeded", { summary: "Réduction appliquée au panier" });
    missions.appendEvent(bill, "mission.succeeded", { summary: "Facture du panier corrigée" });

    const all = search.search({ query: "panier", workspaceId: null, missionId: null, limit: 10 });
    expect(all.map((hit) => [hit.missionTitle, hit.type])).toEqual([
      ["Facture", "mission.succeeded"],
      ["Panier", "mission.succeeded"],
      ["Panier", "mission.failed"],
    ]);
    expect(JSON.parse(all[1]?.payload ?? "{}")).toEqual({ summary: "Réduction appliquée au panier" });

    expect(search.search({ query: "reduc", workspaceId: null, missionId: null, limit: 10 }).map((hit) => hit.seq)).toEqual([all[1]?.seq]);
    expect(search.search({ query: "ECHOUE panier", workspaceId: null, missionId: null, limit: 10 }).map((hit) => hit.type)).toEqual(["mission.failed"]);
    expect(search.search({ query: "panier facture", workspaceId: wsA, missionId: null, limit: 10 })).toEqual([]);
    expect(search.search({ query: "panier", workspaceId: wsB, missionId: null, limit: 10 }).map((hit) => hit.missionId)).toEqual([bill]);
    expect(search.search({ query: "panier", workspaceId: null, missionId: cart, limit: 1 }).map((hit) => hit.type)).toEqual(["mission.succeeded"]);
    // Punctuation in the query neither errors nor empties the result.
    expect(search.search({ query: "panier (", workspaceId: null, missionId: cart, limit: 10 })).toHaveLength(2);
  });

  it("treats FTS syntax in user text as plain words", () => {
    const search = createTimelineSearchRepo(store.db);
    const ws = workspace("/a");
    const id = mission(ws, "M");
    missions.appendEvent(id, "mission.failed", { reason: "internal", detail: "alpha beta" });
    expect(search.search({ query: "alpha OR gamma", workspaceId: null, missionId: null, limit: 10 })).toEqual([]);
    expect(search.search({ query: "detail: NEAR(alpha beta)", workspaceId: null, missionId: null, limit: 10 })).toEqual([]);
    expect(search.search({ query: "alpha NEAR beta", workspaceId: null, missionId: null, limit: 10 })).toEqual([]);
    expect(search.search({ query: "beta alpha", workspaceId: null, missionId: null, limit: 10 })).toHaveLength(1);
  });
});
