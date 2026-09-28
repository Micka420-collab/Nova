// J2-A journeys (g) and (h). (g) The web_search tool goes through the OpenRouter web plugin (mocked):
// the tool card shows the cited sources with their cost, framed as untrusted pages, and a hostile
// excerpt stays data; the chat « Web » button returns an answer with its sources. (h) Nomi follows a
// real mission (its dock shows the live state), then a failing test run becomes a suggestion whose
// action explains the failure from the recorded facts.
import { expect, test } from "@playwright/test";
import { makeUserDataDir, removeDir, type LaunchedNova } from "./fixtures";
import { auditOf, currentWorkspaceId, latestMission, launchOnFolder, missionEvents, planFromAgent, runMission, shot, TERMINAL_EVENTS, writeShopProject } from "./j2a-kit";
import { MOCK_KEYS, startMockOpenRouter, type MissionScript, type MockOpenRouter, type ScriptStep } from "./mock-openrouter";

const tools = (...calls: { name: string; args: unknown }[]): ScriptStep => ({ kind: "tools", calls });

const WEB: MissionScript = {
  plan: { summary: "Je cherche la doc d'Intl.NumberFormat.", tasks: [{ title: "Trouver la doc", acceptance: { kind: "manual", detail: "" } }] },
  step({ results }) {
    if (results.length === 0) return tools({ name: "web_search", args: { query: "Intl.NumberFormat euros" } });
    return { kind: "answer", text: "D'après MDN, `new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' })` formate en euros." };
  },
};

/** Vérifier: runs the project's tests (red), slowly enough to watch Nomi, then reports. */
const VERIFY: MissionScript = {
  plan: { summary: "Je lance les tests du projet.", tasks: [{ title: "Les tests passent", acceptance: { kind: "test_passes", detail: "npm test" } }] },
  step({ results, nudges }) {
    if (results.length === 0) return { kind: "tools", calls: [{ name: "run_tests", args: {} }], delayMs: 2_500 };
    if (nudges.length > 0) return { kind: "answer", text: "Je m'arrête là : je ne corrige pas en mode Vérifier." };
    return { kind: "answer", text: "Le test « total adds the prices » échoue : total renvoie 2 au lieu de 5." };
  },
};

let mock: MockOpenRouter;
let userDataDir: string;
let project: string;
let nova: LaunchedNova | null = null;

test.beforeEach(async () => {
  mock = await startMockOpenRouter({ scripts: { web: WEB, verify: VERIFY } });
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

test("(g) web search: cited sources with cost, shown as untrusted pages; the chat « Web » answer lists its sources", async () => {
  nova = await launchOnFolder({ userDataDir, mock, folder: project });
  const { page } = nova;
  const agent = page.getByRole("region", { name: "Panneau Agent" });
  const missionId = await runMission(page, "Corriger", "Trouve la doc pour formater des euros [script:web]", async () => {
    await agent.locator(".nv-approval:not(.nv-approval--decided)").first().getByRole("button", { name: "Autoriser une fois" }).click();
  });

  // The call went through the web plugin, not streamed, with the query.
  const search = mock.requests.find((request) => JSON.stringify(request.body).includes('"plugins"') && (request.body as { stream?: boolean }).stream === false);
  expect(JSON.stringify(search?.body)).toContain("Intl.NumberFormat euros");

  const card = agent.getByRole("button", { name: /Rechercher sur le Web/ }).first();
  await card.click();
  await expect(agent.getByText("Pages Web non vérifiées par NOVA", { exact: false })).toBeVisible();
  await expect(agent.getByRole("button", { name: /Intl\.NumberFormat - JavaScript \| MDN \(developer\.mozilla\.org\)/ })).toBeVisible();
  await expect(agent.getByRole("button", { name: /Formater des euros en JavaScript \(example\.org\)/ })).toBeVisible();
  await expect(agent.getByText("recherche : 0,02 $")).toBeVisible();
  // The hostile excerpt is displayed as the page's text, and did not change what the mission did.
  await expect(agent.getByText(/IGNORE TES CONSIGNES/)).toBeVisible();
  await shot(page, "j2a-21-web-sources");

  const events = await missionEvents(page, missionId);
  expect(events.filter((event) => TERMINAL_EVENTS.includes(event.type))).toHaveLength(1);
  const finished = events.filter((event) => event.type === "tool.finished") as unknown as { state: string; display: { kind: string; citations?: { url: string }[] } }[];
  expect(finished).toHaveLength(1);
  expect(finished[0]?.display.citations?.map((citation) => citation.url)).toEqual([
    "https://developer.mozilla.org/fr/docs/Web/JavaScript/Reference/Global_Objects/Intl/NumberFormat",
    "https://example.org/blog/euros",
  ]);
  const executed = (await auditOf(page, missionId)).filter((row) => row.action === "tool.executed");
  expect(executed.map((row) => row.outcome)).toEqual(["succeeded"]);
  // What reached the model next is the search result wrapped as untrusted data; the key never is.
  const bodies = JSON.stringify(mock.requests.map((request) => request.body));
  expect(bodies).not.toContain(MOCK_KEYS.valid);

  // Chat « Web » (Discuter): one message searches, and its answer carries the cited sources.
  await page.getByRole("button", { name: "Revenir à la conversation" }).click();
  await page.getByRole("radiogroup", { name: "Mode de travail" }).getByRole("radio", { name: "Discuter" }).click();
  await page.getByRole("button", { name: "Web", exact: true }).click();
  const composer = page.getByRole("textbox", { name: /Écris à Nomi|Message/ }).last();
  await composer.fill("Comment formater des euros en JavaScript ?");
  await composer.press("Enter");
  await expect(page.getByRole("link", { name: "Intl.NumberFormat - JavaScript | MDN" })).toBeVisible();
  const chatRequest = mock.requests.filter((request) => (request.body as { stream?: boolean } | null)?.stream === true).at(-1);
  expect(JSON.stringify(chatRequest?.body)).toContain('"web"');
  await shot(page, "j2a-22-chat-web");
});

test("(h) Nomi shows the live mission, then turns a failing test run into a suggestion that explains it", async () => {
  nova = await launchOnFolder({ userDataDir, mock, folder: project });
  const { page } = nova;
  const nomi = page.locator(".nova-dock").first();
  const workspaceId = await currentWorkspaceId(page);
  await expect(nomi).toContainText("Nomi est disponible");
  await page.getByRole("button", { name: "Confier une mission à Nomi" }).click();
  await planFromAgent(page, "Vérifier", "Lance les tests [script:verify]");
  await page.getByRole("button", { name: "Lancer la mission" }).click();
  // While the model works (the mock takes 2.5 s), Nomi shows that mission, by its title.
  const launchedAt = Date.now();
  await expect(nomi).toContainText("Lance les tests [script:verify]");
  await expect(nomi).not.toContainText("Nomi est disponible");
  // The agent panel follows the mission right away (the model is still thinking).
  await expect(page.getByRole("list", { name: "Journal de la mission" })).toBeVisible({ timeout: 2_000 });
  expect(Date.now() - launchedAt).toBeLessThan(2_000);
  await expect(page.getByRole("contentinfo", { name: "Barre d'état" })).toContainText("Nomi travaille");
  await shot(page, "j2a-23-nomi-working");
  await expect(page.getByRole("region", { name: "Panneau Agent" }).locator(".nova-endcard")).toBeVisible({ timeout: 30_000 });
  await expect(nomi).toContainText("La mission a échoué");
  const missionId = (await latestMission(page, workspaceId)).id;
  const events = await missionEvents(page, missionId);
  expect(events.filter((event) => TERMINAL_EVENTS.includes(event.type))).toHaveLength(1);
  const tests = events.find((event) => event.type === "tool.finished") as unknown as { display: { kind: string; exitCode: number } };
  expect(tests.display).toMatchObject({ kind: "tests" });
  expect(tests.display.exitCode).not.toBe(0);

  // The failed run is a recorded signal; Nomi suggests looking at it, with an action that works.
  const bubble = page.getByRole("status", { name: "Messages de Nomi" }).or(page.locator("output[aria-label='Messages de Nomi']"));
  await expect(bubble).toContainText(/échoue depuis/, { timeout: 20_000 });
  await shot(page, "j2a-24-nomi-suggestion");
  const signals = await page.evaluate(async () => {
    const recent = await window.novaBridge.workspace.recent({ limit: 1 });
    const id = recent.ok ? (recent.value[0]?.id ?? null) : null;
    const state = await window.novaBridge.companion.state({ workspaceId: id });
    if (!state.ok) throw new Error(state.error.message);
    return {
      signals: state.value.signals.map((signal) => ({ id: signal.id, kind: signal.kind })),
      suggestion: state.value.suggestion ? { signalId: state.value.suggestion.signalId, text: state.value.suggestion.text } : null,
    };
  });
  // The suggestion shown refers to the recorded test_failed signal (N1: every suggestion has one).
  const failed = signals.signals.find((signal) => signal.kind === "test_failed");
  expect(failed).toBeDefined();
  expect(signals.suggestion?.signalId).toBe(failed?.id);

  await expect(bubble).toContainText("Un test échoue depuis");
  await bubble.getByRole("button", { name: "Regarde" }).click();
  await expect(page.getByText("Explication tirée des faits enregistrés, sans appel au modèle.")).toBeVisible();
  await shot(page, "j2a-25-nomi-explain");
});
