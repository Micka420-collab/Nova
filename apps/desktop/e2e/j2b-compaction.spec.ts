// J2-B lane L2 (C7/A15): compaction is never silent and a model switch goes through a dossier.
// (a) a mission passes 80 % of its model's context → « Résumé proposé » card → Appliquer → the next
//     request carries the summary (and nothing changed before the click);
// (b) « /compact » in Discuter writes a proposal; once applied, the next message is sent with the
//     summary instead of the history it covers;
// (c) « Changer de modèle » while a mission waits for an approval → dossier shown → the next
//     request goes to the new model and starts from the dossier.
//
// Wiring assumed (integrator, J2-B lane map §L2): `context.*` served by `createContextService`, its
// `runtimeHook` passed as `MainRuntimeHandlers.context`, `historyForModel` given to the ChatRunner
// and `observeConversation` called on each completed answer; `MissionContextPanel` mounted in the
// agent panel under the running mission, `ConversationContextPanel` in Discuter, « /compact »
// routed by the Composer through `parseCompactCommand` + `useCompactAction`.
// Mock assumed (integrator): `ScriptStep.promptTokens` sets the reported `usage.prompt_tokens`.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { makeUserDataDir, removeDir, type LaunchedNova } from "./fixtures";
import { MODEL_ID, currentWorkspaceId, latestMission, launchOnFolder, missionEvents, planFromAgent, shot, writeShopProject } from "./j2a-kit";
import { startMockOpenRouter, type MissionScript, type MockOpenRouter, type ScriptStep } from "./mock-openrouter";

const NEXT_MODEL = "deepseek/deepseek-v3.2";

/** Context length of the default model in the mock catalog: usage is reported as 90 % of it. */
function contextLengthOf(modelId: string): number {
  const path = fileURLToPath(new URL("../../../packages/providers/src/__fixtures__/openrouter-models.json", import.meta.url));
  const models = JSON.parse(readFileSync(path, "utf8")) as { data: { id: string; context_length: number }[] };
  const length = models.data.find((model) => model.id === modelId)?.context_length;
  if (!length) throw new Error(`no context length for ${modelId}`);
  return length;
}

/** A step whose reported prompt usage is `tokens` (mock option `promptTokens`). */
function heavy(step: ScriptStep, tokens: number): ScriptStep {
  const withUsage: ScriptStep & { promptTokens: number } = { ...step, promptTokens: tokens };
  return withUsage;
}

const FULL = Math.floor(contextLengthOf(MODEL_ID) * 0.9);

const LONG_MISSION: MissionScript = {
  plan: { summary: "Je lis puis je corrige le panier.", tasks: [{ title: "Corriger le total", acceptance: { kind: "manual", detail: "" } }] },
  step({ results, nudges }) {
    // An applied summary replaces the calls it covers (the read): it counts as that progress.
    const summarized = nudges.some((nudge) => nudge.startsWith("Summary of the earlier"));
    const progress = results.length + (summarized ? 1 : 0);
    if (progress === 0) return heavy({ kind: "tools", calls: [{ name: "read_file", args: { path: "src/cart.js" } }] }, FULL);
    // The edit waits for an approval: the user decides on the proposal meanwhile.
    if (progress === 1) {
      return heavy({ kind: "tools", calls: [{ name: "edit_file", args: { path: "src/cart.js", edits: [{ oldText: "prices.length", newText: "prices.reduce((sum, price) => sum + price, 0)" }] } }] }, FULL);
    }
    return { kind: "answer", text: "Le total additionne maintenant les prix." };
  },
};

const SWITCH_MISSION: MissionScript = {
  plan: { summary: "Je corrige le panier.", tasks: [{ title: "Corriger le total", acceptance: { kind: "manual", detail: "" } }] },
  step({ results, nudges }) {
    // After a model switch the new model starts from the handoff dossier (the edit is in it).
    const handedOver = nudges.some((nudge) => nudge.startsWith("Handoff dossier"));
    if (results.length === 0 && !handedOver) {
      return { kind: "tools", calls: [{ name: "edit_file", args: { path: "src/cart.js", edits: [{ oldText: "prices.length", newText: "prices.reduce((sum, price) => sum + price, 0)" }] } }] };
    }
    return { kind: "answer", text: "Corrigé." };
  },
};

let mock: MockOpenRouter;
let userDataDir: string;
let project: string;
let nova: LaunchedNova | null = null;

test.beforeEach(async () => {
  mock = await startMockOpenRouter({ scripts: { "long-mission": LONG_MISSION, "switch-model": SWITCH_MISSION } });
  userDataDir = makeUserDataDir();
  project = makeUserDataDir();
  writeShopProject(project);
});

test.afterEach(async () => {
  await nova?.app.close();
  nova = null;
  await mock.close();
  removeDir(userDataDir);
  removeDir(project);
});

interface ChatBodyLike {
  model?: string;
  tools?: unknown[];
  messages?: { role: string; content?: string | null }[];
}

/** Mission step requests (the ones carrying tools), oldest first. */
function stepRequests(): ChatBodyLike[] {
  return mock.requests
    .filter((request) => request.path.endsWith("/chat/completions"))
    .map((request) => request.body as ChatBodyLike)
    .filter((body) => Array.isArray(body.tools));
}

async function startMission(page: Page, goal: string): Promise<void> {
  await page.getByRole("button", { name: "Confier une mission à Nomi" }).click();
  await planFromAgent(page, "Corriger", goal);
  await page.getByRole("button", { name: "Lancer la mission" }).click();
}

test("(a) a mission past 80 % gets a summary proposal, applied only by the user", async () => {
  test.setTimeout(120_000);
  nova = await launchOnFolder({ userDataDir, mock, folder: project });
  const { page } = nova;
  const workspaceId = await currentWorkspaceId(page);
  await startMission(page, "Le total du panier est faux [script:long-mission]");
  const agent = page.getByRole("region", { name: "Panneau Agent" });

  const card = agent.getByRole("article", { name: "Résumé proposé" });
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card).toContainText("Ceci est un résumé, pas une réponse du modèle.");
  await expect(agent.getByRole("meter", { name: "Contexte utilisé" })).toBeVisible();
  await shot(page, "j2b-l2-01-proposal");
  const beforeApply = stepRequests().length;
  await card.getByRole("button", { name: "Appliquer" }).click();
  await expect(agent.getByRole("article", { name: "Résumé appliqué" })).toBeVisible();
  await agent.getByRole("button", { name: "Autoriser une fois" }).click();
  await expect(agent.locator(".nova-endcard")).toBeVisible({ timeout: 30_000 });

  // Requests before the click never carried a summary; the one after it does.
  const steps = stepRequests();
  const hasSummary = (body: ChatBodyLike | undefined) =>
    (body?.messages ?? []).some((message) => message.role === "user" && (message.content ?? "").includes("approved by the user"));
  expect(steps.slice(0, beforeApply).some(hasSummary)).toBe(false);
  expect(hasSummary(steps.at(-1))).toBe(true);

  const mission = await latestMission(page, workspaceId);
  const types = (await missionEvents(page, mission.id)).map((event) => event.type);
  expect(types).toEqual(expect.arrayContaining(["compaction.proposed", "compaction.applied"]));
  // Live usage is shown but never stored.
  expect(types).not.toContain("context.usage");
});

test("(b) /compact in Discuter proposes a summary; once applied it replaces the history sent", async () => {
  test.setTimeout(90_000);
  nova = await launchOnFolder({ userDataDir, mock, folder: project });
  const { page } = nova;
  const home = page.getByRole("textbox", { name: /Décris ton idée|Message/ }).first();
  await home.fill("Explique le panier");
  await home.press("Enter");
  await expect(page.getByText(/Réponse simulée n°1/)).toBeVisible();
  // The answer is complete (its usage line is shown) before the next command: while it streams,
  // Enter does not send, and « /compact » would stay in the composer.
  await expect(page.getByText(/envoyés : 42 jetons/)).toBeVisible();
  // The conversation continues in the chat composer.
  const composer = page.getByRole("textbox", { name: "Message" }).last();
  await composer.fill("/compact garder les noms de fichiers");
  await composer.press("Enter");

  const card = page.getByRole("article", { name: "Résumé proposé" });
  await expect(card).toBeVisible({ timeout: 30_000 });
  await card.getByRole("button", { name: "Appliquer" }).click();
  await expect(page.getByRole("article", { name: "Résumé appliqué" })).toBeVisible();
  await shot(page, "j2b-l2-02-chat-compact");

  await composer.fill("Et la facture ?");
  await composer.press("Enter");
  await expect.poll(() => mock.requests.filter((request) => request.path.endsWith("/chat/completions")).length).toBeGreaterThanOrEqual(3);
  const last = mock.requests.filter((request) => request.path.endsWith("/chat/completions")).at(-1)?.body as ChatBodyLike;
  const contents = (last.messages ?? []).map((message) => message.content ?? "");
  expect(contents.some((content) => content.startsWith("Summary of the earlier conversation (approved by the user)"))).toBe(true);
  expect(contents).not.toContain("Explique le panier");
});

test("(c) switching model mid-mission goes through a dossier and the next request uses the new model", async () => {
  test.setTimeout(90_000);
  nova = await launchOnFolder({ userDataDir, mock, folder: project });
  const { page } = nova;
  const workspaceId = await currentWorkspaceId(page);
  await startMission(page, "Le total du panier est faux [script:switch-model]");
  const agent = page.getByRole("region", { name: "Panneau Agent" });
  const approve = agent.getByRole("button", { name: "Autoriser une fois" });
  await expect(approve).toBeVisible({ timeout: 30_000 });

  await agent.getByRole("button", { name: "Changer de modèle" }).click();
  await agent.getByRole("combobox", { name: "Nouveau modèle" }).selectOption(NEXT_MODEL);
  await agent.getByRole("button", { name: "Changer", exact: true }).click();
  await expect(agent.getByRole("article", { name: new RegExp(`Dossier de passation : ${MODEL_ID} → ${NEXT_MODEL}`) })).toBeVisible();
  await shot(page, "j2b-l2-03-handoff");
  await approve.click();
  await expect(agent.locator(".nova-endcard")).toBeVisible({ timeout: 30_000 });

  const last = stepRequests().at(-1);
  expect(last?.model).toBe(NEXT_MODEL);
  expect((last?.messages ?? []).some((message) => (message.content ?? "").startsWith("Handoff dossier prepared by NOVA"))).toBe(true);
  const mission = await latestMission(page, workspaceId);
  const events = await missionEvents(page, mission.id);
  expect(events.map((event) => event.type)).toEqual(expect.arrayContaining(["handoff.created", "model.switched"]));
  expect(events.find((event) => event.type === "model.switched")).toMatchObject({ fromModelId: MODEL_ID, toModelId: NEXT_MODEL });
});
