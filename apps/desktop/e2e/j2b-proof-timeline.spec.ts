// J2-B L8 journey: a « Corriger » mission with « Jusqu'à preuve » on. The scripted model runs the
// real `npm test` (red), claims it is done twice, and NOVA starts a continuation round instead of
// failing; in that round the model fixes the cart (approved in the card) and the tests go green:
// `continuation.round 1` → `continuation.stopped proven` → `mission.succeeded`. Then the timeline
// search finds the mission by « panier », and « Bifurquer d'ici » prepares a NEW mission, ready,
// linked to the original, which stays untouched. Requires the integrator wiring (continuation
// handlers + beforeRuntimeEvent in missions-service, harness.timeline, AutoContinueOption in the
// contract sheet, ContinuationStatus and EventActions in the mission timeline).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { makeUserDataDir, removeDir, type LaunchedNova } from "./fixtures";
import { CART_FIXED, currentWorkspaceId, launchOnFolder, missionEvents, planFromAgent, shot, TERMINAL_EVENTS, writeShopProject } from "./j2a-kit";
import { startMockOpenRouter, type MissionScript, type MockOpenRouter, type ScriptStep } from "./mock-openrouter";

const tools = (...calls: { name: string; args: unknown }[]): ScriptStep => ({ kind: "tools", calls });

/** Red tests, two claims (round 0), then — only once NOVA asked for a continuation round — the fix. */
const PROOF: MissionScript = {
  plan: {
    summary: "Je lance les tests du panier et je corrige ce qui échoue.",
    tasks: [{ title: "Le test du panier passe", acceptance: { kind: "test_passes", detail: "npm test" } }],
  },
  step({ results, nudges }) {
    const tests = results.filter((result) => result.name === "run_tests").length;
    const inRound = nudges.some((nudge) => nudge.startsWith("Continuation round"));
    if (tests === 0) return tools({ name: "run_tests", args: {} });
    if (!inRound) return { kind: "answer", text: "Fini, le panier est bon." };
    if (!results.some((result) => result.name === "edit_file")) {
      return tools({ name: "edit_file", args: { path: "src/cart.js", edits: [{ oldText: "return prices.length;", newText: "return prices.reduce((sum, price) => sum + price, 0);" }] } });
    }
    if (tests < 2) return tools({ name: "run_tests", args: {} });
    return { kind: "answer", text: "Le total du panier additionne les prix ; `npm test` passe." };
  },
};

let mock: MockOpenRouter;
let userDataDir: string;
let project: string;
let nova: LaunchedNova | null = null;

test.beforeEach(async () => {
  mock = await startMockOpenRouter({ scripts: { proof: PROOF } });
  userDataDir = makeUserDataDir();
  project = makeUserDataDir();
  writeShopProject(project);
});

test.afterEach(async () => {
  await nova?.app.close().catch(() => {});
  nova = null;
  await mock.close();
  removeDir(userDataDir);
  removeDir(project);
});

test("« Jusqu'à preuve »: red at round 0, green at round 1, proven; search finds it; « Bifurquer d'ici » prepares a linked mission", async () => {
  test.setTimeout(180_000);
  nova = await launchOnFolder({ userDataDir, mock, folder: project });
  const { page } = nova;
  const workspaceId = await currentWorkspaceId(page);
  await page.getByRole("button", { name: "Confier une mission à Nomi" }).click();
  await planFromAgent(page, "Corriger", "Corrige le total du panier [script:proof]");

  // Off by default; turning it on shows its two bounds.
  const option = page.getByRole("switch", { name: "Jusqu’à preuve" });
  await expect(option).toBeVisible();
  await expect(option).not.toBeChecked();
  await option.click();
  await expect(option).toBeChecked();
  await page.getByRole("textbox", { name: /Tours au maximum/ }).fill("2");
  await expect(page.getByText(/Compris dans le budget de la mission/)).toBeVisible();
  await shot(page, "j2b-proof-01-contract");
  await page.getByRole("button", { name: "Lancer la mission" }).click();

  // The fix is written only after the approval in the card (round 1).
  const agent = page.getByRole("region", { name: "Panneau Agent" });
  const approveOnce = agent.getByRole("button", { name: "Autoriser une fois" });
  await expect(approveOnce).toBeVisible({ timeout: 60_000 });
  await expect(agent.getByText(/Jusqu’à preuve · Tour 1 sur 2/)).toBeVisible();
  await shot(page, "j2b-proof-02-round");
  await approveOnce.click();

  await expect(agent.locator(".nova-endcard")).toBeVisible({ timeout: 60_000 });
  await expect(agent.getByText(/Preuve obtenue · 1 tour/)).toBeVisible();
  await shot(page, "j2b-proof-03-proven");
  expect(readFileSync(join(project, "src/cart.js"), "utf8")).toBe(CART_FIXED);

  const original = await page.evaluate(async (id) => {
    const list = await window.novaBridge.missions.list({ workspaceId: id, limit: 1 });
    if (!list.ok || !list.value.items[0]) throw new Error("no mission");
    return list.value.items[0];
  }, workspaceId);
  expect(original.state).toBe("succeeded");
  const events = await missionEvents(page, original.id);
  const flow = events.filter((event) => event.type.startsWith("continuation.") || TERMINAL_EVENTS.includes(event.type)).map((event) => event.type);
  expect(flow).toEqual(["continuation.round", "continuation.stopped", "mission.succeeded"]);
  expect(events.find((event) => event.type === "continuation.stopped")).toMatchObject({ reason: "proven", rounds: 1 });
  expect(events.find((event) => event.type === "continuation.round")).toMatchObject({ round: 1, maxRounds: 2 });

  // Search: « panier » finds the mission's events, redacted excerpts, never raw JSON.
  const hits = await page.evaluate(async (id) => {
    const result = await window.novaBridge.timeline.search({ query: "panier", workspaceId: id, missionId: null, limit: 20 });
    if (!result.ok) throw new Error(result.error.message);
    return result.value;
  }, workspaceId);
  expect(hits.length).toBeGreaterThan(0);
  expect(hits.every((hit) => hit.missionId === original.id && hit.snippet.length <= 300 && !hit.snippet.includes('":'))).toBe(true);

  // « Bifurquer d'ici » on an event of the mission: a NEW mission, ready, linked; nothing replayed.
  const before = events.length;
  await agent.getByRole("button", { name: "Bifurquer d’ici" }).first().click();
  await expect(agent.getByText(/Rien n’est rejoué/)).toBeVisible();
  await agent.getByRole("textbox", { name: /Nouvel objectif/ }).fill("Ajoute une remise de 10 % au panier [script:proof]");
  await agent.getByRole("button", { name: "Préparer la mission" }).click();
  await expect(agent.getByText(/Mission prête/)).toBeVisible({ timeout: 30_000 });
  await shot(page, "j2b-proof-04-fork");

  const forked = await page.evaluate(async (id) => {
    const list = await window.novaBridge.missions.list({ workspaceId: id, limit: 5 });
    if (!list.ok) throw new Error(list.error.message);
    return list.value.items;
  }, workspaceId);
  const child = forked.find((mission) => mission.id !== original.id);
  expect(child?.state).toBe("ready");
  const childEvents = await missionEvents(page, child?.id ?? "");
  expect(childEvents.map((event) => event.type)).toContain("mission.forked");
  expect(childEvents.find((event) => event.type === "mission.forked")).toMatchObject({ fromMissionId: original.id });
  expect(childEvents.some((event) => event.type === "tool.requested")).toBe(false);
  expect((await missionEvents(page, original.id)).length).toBe(before);
});
