// J2-A journeys (i) and (j). (i) Acceptance scenario 10 (one worker): a low cap set in the contract
// sheet suspends the mission before the call that could cross it, with the spend shown; raising the
// cap resumes it to its end. « Arrêter » cuts a model call in flight and the mission ends with
// exactly one terminal outcome. (j) Scenario 11: NOVA is killed right after a command produced an
// external effect; after the restart the mission is not replayed, the effect happened once, and
// the interrupted action is shown as such (never as still running).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { launchNova, makeUserDataDir, removeDir, type LaunchedNova } from "./fixtures";
import { connect, currentWorkspaceId, latestMission, launchOnFolder, missionEvents, planFromAgent, shot, TERMINAL_EVENTS, writeShopProject } from "./j2a-kit";
import { startMockOpenRouter, type MissionScript, type MockOpenRouter } from "./mock-openrouter";

const FILES = ["package.json", "src/cart.js", "src/format.js", "README.md", "test/cart.test.js"];

/** Reads one file per turn, each turn reporting 0.0005 $ (below the per-call reservation). */
const SPEND: MissionScript = {
  plan: { summary: "Je lis tout le projet.", tasks: [{ title: "Tout lire", acceptance: { kind: "manual", detail: "" } }] },
  step({ results }) {
    if (results.length >= 3) return { kind: "answer", text: "J'ai lu le projet.", costUsd: 0.0005 };
    return { kind: "tools", calls: [{ name: "read_file", args: { path: FILES[results.length] } }], costUsd: 0.0005 };
  },
};

const HANG: MissionScript = {
  plan: { summary: "Je réfléchis longtemps.", tasks: [{ title: "Réfléchir", acceptance: { kind: "manual", detail: "" } }] },
  step: () => ({ kind: "hang" }),
};

let mock: MockOpenRouter;
let userDataDir: string;
let project: string;
let nova: LaunchedNova | null = null;
let effectPid: number | null = null;

function effectScript(origin: string): MissionScript {
  // The command records its pid, hits the counter once, then never ends (NOVA is killed meanwhile).
  const code = `require('fs').writeFileSync('effect.pid', String(process.pid)); fetch('${origin}/effect').then(() => setInterval(() => {}, 1000))`;
  return {
    plan: { summary: "Je préviens le serveur de test.", tasks: [{ title: "Prévenir", acceptance: { kind: "manual", detail: "" } }] },
    step({ results }) {
      if (results.length === 0) return { kind: "tools", calls: [{ name: "run_command", args: { argv: ["node", "-e", code] } }] };
      return { kind: "answer", text: "C'est fait." };
    },
  };
}

test.beforeEach(async () => {
  mock = await startMockOpenRouter({ scripts: { spend: SPEND, hang: HANG } });
  userDataDir = makeUserDataDir();
  project = makeUserDataDir();
  writeShopProject(project);
});

test.afterEach(async () => {
  if (effectPid !== null) {
    try {
      process.kill(effectPid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  effectPid = null;
  await nova?.app.close().catch(() => {});
  nova = null;
  await mock.close();
  removeDir(userDataDir);
  removeDir(project);
});

async function spent(page: Page, missionId: string): Promise<{ spentUsd: number; budgetUsd: number; state: string }> {
  return page.evaluate(async (id) => {
    const detail = await window.novaBridge.missions.get({ missionId: id, afterSeq: 0 });
    if (!detail.ok) throw new Error(detail.error.message);
    return { spentUsd: detail.value.budget.spentUsd, budgetUsd: detail.value.budget.budgetUsd, state: detail.value.mission.state };
  }, missionId);
}

const completions = (m: MockOpenRouter) => m.requests.filter((request) => request.path === "/api/v1/chat/completions");

test("(i) budget: the cap suspends before the next call, raising it resumes; « Arrêter » ends with one outcome", async () => {
  test.setTimeout(150_000);
  nova = await launchOnFolder({ userDataDir, mock, folder: project });
  const { page } = nova;
  const workspaceId = await currentWorkspaceId(page);
  const agent = page.getByRole("region", { name: "Panneau Agent" });

  await page.getByRole("button", { name: "Confier une mission à Nomi" }).click();
  await planFromAgent(page, "Comprendre", "Lis tout le projet [script:spend]");
  await page.getByRole("textbox", { name: "Budget maximal ($)" }).fill("0,002");
  await page.getByRole("button", { name: "Lancer la mission" }).click();

  const banner = agent.getByText("Mission suspendue : plafond atteint").first();
  await expect(banner).toBeVisible({ timeout: 30_000 });
  const missionId = (await latestMission(page, workspaceId)).id;
  const atCap = await spent(page, missionId);
  expect(atCap.state).toBe("suspended");
  expect(atCap.budgetUsd).toBe(0.002);
  // The reported spend never crosses the cap: the call that could have crossed it never left.
  expect(atCap.spentUsd).toBeLessThanOrEqual(0.002);
  const callsAtCap = completions(mock).length;
  await page.waitForTimeout(1_500);
  expect(completions(mock).length).toBe(callsAtCap);
  await expect(page.getByRole("contentinfo", { name: "Barre d'état" })).toContainText("Mission suspendue");
  await shot(page, "j2a-26-budget-suspended");

  // Raise the cap from the banner: the mission resumes and ends.
  await agent.getByRole("textbox", { name: "Nouveau plafond de la mission ($)" }).fill("0,01");
  await agent.getByRole("button", { name: "Relever le plafond et reprendre" }).click();
  await expect(agent.locator(".nova-endcard")).toBeVisible({ timeout: 30_000 });
  const events = await missionEvents(page, missionId);
  expect(events.filter((event) => event.type === "mission.suspended")).toMatchObject([{ reason: "budget" }]);
  expect(events.filter((event) => event.type === "mission.resumed")).toHaveLength(1);
  expect(events.filter((event) => TERMINAL_EVENTS.includes(event.type)).map((event) => event.type)).toEqual(["mission.succeeded"]);
  const after = await spent(page, missionId);
  expect(after.spentUsd).toBeLessThanOrEqual(0.01);
  await shot(page, "j2a-27-budget-resumed");

  // « Arrêter » while the model is answering: the call is cut, one terminal outcome, nothing after.
  await page.getByRole("navigation", { name: "Espaces" }).getByRole("button", { name: "Accueil" }).click();
  await page.getByRole("button", { name: "Confier une mission à Nomi" }).click();
  await planFromAgent(page, "Comprendre", "Réfléchis longtemps [script:hang]");
  await page.getByRole("button", { name: "Lancer la mission" }).click();
  await expect.poll(() => completions(mock).some((request) => !request.aborted && JSON.stringify(request.body).includes("[script:hang]") && Array.isArray((request.body as { tools?: unknown }).tools))).toBe(true);
  await agent.getByRole("button", { name: "Arrêter" }).first().click();
  await page.getByRole("dialog", { name: "Arrêter la mission ?" }).getByRole("button", { name: "Arrêter la mission" }).click();
  await expect(agent.locator(".nova-endcard")).toBeVisible();
  const stoppedId = (await latestMission(page, workspaceId)).id;
  const stopped = await missionEvents(page, stoppedId);
  expect(stopped.filter((event) => TERMINAL_EVENTS.includes(event.type)).map((event) => event.type)).toEqual(["mission.cancelled"]);
  await expect.poll(() => completions(mock).filter((request) => JSON.stringify(request.body).includes("[script:hang]") && Array.isArray((request.body as { tools?: unknown }).tools)).every((request) => request.aborted)).toBe(true);
  const settled = completions(mock).length;
  await page.waitForTimeout(1_500);
  expect(completions(mock).length).toBe(settled);
  expect((await missionEvents(page, stoppedId)).filter((event) => TERMINAL_EVENTS.includes(event.type))).toHaveLength(1);
  await shot(page, "j2a-28-mission-stopped");
});

test("(j) crash after an external effect, then restart: no replay, one effect, the interrupted action is shown as such", async () => {
  test.setTimeout(150_000);
  // The effect counter is the mock itself: its script needs the origin, known once it listens.
  await mock.close();
  const scripts: Record<string, MissionScript> = {};
  mock = await startMockOpenRouter({ scripts });
  scripts.effect = effectScript(mock.origin);
  nova = await launchOnFolder({ userDataDir, mock, folder: project });
  const { page } = nova;
  const workspaceId = await currentWorkspaceId(page);
  const agent = page.getByRole("region", { name: "Panneau Agent" });
  await page.getByRole("button", { name: "Confier une mission à Nomi" }).click();
  await planFromAgent(page, "Corriger", "Préviens le serveur [script:effect]");
  await page.getByRole("button", { name: "Lancer la mission" }).click();
  await agent.locator(".nv-approval:not(.nv-approval--decided)").first().getByRole("button", { name: "Autoriser une fois" }).click();

  // The effect happened; the command is still running. NOVA dies now.
  await expect.poll(() => mock.effects(), { timeout: 20_000 }).toBe(1);
  await expect.poll(() => existsSync(join(project, "effect.pid"))).toBe(true);
  effectPid = Number(readFileSync(join(project, "effect.pid"), "utf8"));
  const missionId = (await latestMission(page, workspaceId)).id;
  const requestsBefore = completions(mock).length;
  nova.app.process().kill("SIGKILL");
  await new Promise((resolve) => setTimeout(resolve, 500));

  nova = await launchNova({ userDataDir, mock });
  const restarted = nova.page;
  await connect(restarted);
  const detail = await restarted.evaluate(async (id) => {
    const got = await window.novaBridge.missions.get({ missionId: id, afterSeq: 0 });
    if (!got.ok) throw new Error(got.error.message);
    return { state: got.value.mission.state, events: got.value.events as unknown as { type: string; callId?: string; state?: string; detail?: string; display?: { kind: string; code?: string } }[] };
  }, missionId);
  // Not replayed: failed as interrupted, one terminal event, no new model call, one effect.
  expect(detail.state).toBe("failed");
  expect(detail.events.filter((event) => TERMINAL_EVENTS.includes(event.type))).toMatchObject([{ type: "mission.failed", detail: "interrompue par l'arrêt de NOVA" }]);
  // The command that was running has a terminal outcome: interrupted, result unknown.
  const commandEnd = detail.events.filter((event) => event.type === "tool.finished");
  expect(commandEnd).toHaveLength(1);
  expect(commandEnd[0]).toMatchObject({ state: "failed", display: { kind: "error", code: "interrupted" } });
  await restarted.waitForTimeout(1_500);
  expect(completions(mock).length).toBe(requestsBefore);
  expect(mock.effects()).toBe(1);

  // The UI says so: the mission card, and the command card is not « en cours ».
  // Reopen the folder from Home's recent list, then its missions.
  await restarted.getByRole("region", { name: "Ouvrir un dossier" }).getByRole("button", { name: /nova-e2e-/ }).first().click();
  await expect(restarted.getByRole("treeitem", { name: /package\.json/ }).first()).toBeVisible();
  await restarted.getByRole("navigation", { name: "Espaces" }).getByRole("button", { name: "Missions" }).click();
  await restarted.getByRole("button", { name: /Préviens le serveur/ }).first().click();
  const panel = restarted.getByRole("region", { name: "Panneau Agent" });
  await expect(panel.getByText(/interrompue par l'arrêt de NOVA/).first()).toBeVisible();
  await expect(panel.getByText("en cours")).toHaveCount(0);
  await expect(panel.getByText(/résultat inconnu/).first()).toBeVisible();
  await shot(restarted, "j2a-29-after-crash");
});
