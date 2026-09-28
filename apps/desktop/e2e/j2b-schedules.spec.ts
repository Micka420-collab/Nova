// J2-B lane L6 (Pr5): scheduled missions. A schedule created from the UI (editor with a preview of
// the next runs, missed-run policy explained, "runs only while NOVA is open") starts its run as a
// normal mission on the OpenRouter mock, the history shows the run and its outcome, and a paused
// schedule starts nothing when its due time passes.
//
// Real clock (no injected time in main): a `once` trigger a few seconds ahead gives a quick run; a
// 1-minute interval paused right after creation proves that pause stops runs (≈ 70 s wait).
//
// Mount point assumed (integrator): a « Planifications » button in the « Espaces » rail shows the
// SchedulesManager of the open project (heading « Missions planifiées », level 1).
import { expect, test, type Page } from "@playwright/test";
import type { MissionContractInput } from "@nova/shared";
import { makeUserDataDir, removeDir, type LaunchedNova } from "./fixtures";
import { MODEL_ID, currentWorkspaceId, launchOnFolder, missionEvents, shot, writeShopProject } from "./j2a-kit";
import { startMockOpenRouter, type MissionScript, type MockOpenRouter } from "./mock-openrouter";

const REPORT: MissionScript = {
  plan: { summary: "Je relis le README.", tasks: [{ title: "Résumer le projet", acceptance: { kind: "manual", detail: "" } }] },
  step() {
    return { kind: "answer", text: "Le projet est un petit panier d'exemple." };
  },
};

const CONTRACT: MissionContractInput = { profile: "read_only", allowedOperations: ["read", "network"], allowedHosts: [], webSearch: false, maxDurationMs: 5 * 60_000, budgetUsd: 0.2 };

let mock: MockOpenRouter;
let userDataDir: string;
let project: string;
let nova: LaunchedNova | null = null;

test.beforeEach(async () => {
  mock = await startMockOpenRouter({ scripts: { sched: REPORT } });
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

async function openSchedules(page: Page): Promise<void> {
  await page.getByRole("navigation", { name: "Espaces" }).getByRole("button", { name: "Planifications" }).click();
  await expect(page.getByRole("heading", { name: "Missions planifiées", level: 1 })).toBeVisible();
}

interface RunRow {
  outcome: string;
  missionId: string | null;
  detail: string | null;
}

async function runsOf(page: Page, scheduleId: string): Promise<RunRow[]> {
  return page.evaluate(async (id) => {
    const listed = await window.novaBridge.schedules.runs({ scheduleId: id, limit: 50 });
    if (!listed.ok) throw new Error(listed.error.message);
    return listed.value.map((run) => ({ outcome: run.outcome, missionId: run.missionId, detail: run.detail }));
  }, scheduleId);
}

interface ScheduleRow {
  id: string;
  title: string;
  state: string;
  nextRunAt: number | null;
}

async function schedulesOf(page: Page, workspaceId: string): Promise<ScheduleRow[]> {
  return page.evaluate(async (id) => {
    const listed = await window.novaBridge.schedules.list({ workspaceId: id });
    if (!listed.ok) throw new Error(listed.error.message);
    return listed.value.map((item) => ({ id: item.id, title: item.title, state: item.state, nextRunAt: item.nextRunAt }));
  }, workspaceId);
}

test("a 1-minute schedule runs a normal mission shown in its history; paused, it runs no more", async () => {
  test.setTimeout(240_000);
  nova = await launchOnFolder({ userDataDir, mock, folder: project });
  const { page } = nova;
  const workspaceId = await currentWorkspaceId(page);
  await openSchedules(page);
  await expect(page.getByText(/tournent seulement quand NOVA est ouvert/)).toBeVisible();

  // Editor: the preview of the next runs is visible before saving; a 1-minute interval.
  await page.getByRole("button", { name: "Nouvelle planification" }).click();
  const form = page.getByRole("form", { name: "Nouvelle planification" });
  await form.getByLabel("Nom", { exact: true }).fill("Veille minute");
  await form.getByLabel(/Objectif de la mission/).fill("[script:sched] Résume le projet.");
  await form.getByRole("radio", { name: "Intervalle" }).click();
  await form.getByLabel("Toutes les (minutes)").fill("1");
  await expect(form.getByRole("region", { name: "Prochaines exécutions" }).getByRole("listitem")).toHaveCount(5);
  await expect(form.getByText("Rattraper une seule fois")).toBeVisible();
  await form.getByRole("radio", { name: "Intervalle" }).scrollIntoViewIfNeeded();
  await shot(page, "j2b-schedules-editor");
  await form.getByRole("button", { name: "Enregistrer" }).click();
  await expect(page.getByText("Veille minute", { exact: true })).toBeVisible();
  const [minute] = (await schedulesOf(page, workspaceId)).filter((item) => item.title === "Veille minute");
  expect(minute?.state).toBe("active");

  // A one-off run a few seconds ahead too (through the bridge: same validation as the editor).
  const once = await page.evaluate(
    async ({ id, modelId, contract }) => {
      const created = await window.novaBridge.schedules.create({
        workspaceId: id,
        title: "Résumé unique",
        goal: "[script:sched] Résume le projet une fois.",
        mode: "understand",
        modelId,
        contract,
        trigger: { kind: "once", at: Date.now() + 4_000 },
        missedPolicy: "skip",
      });
      if (!created.ok) throw new Error(created.error.message);
      return created.value.id;
    },
    { id: workspaceId, modelId: MODEL_ID, contract: CONTRACT },
  );
  await expect(page.getByText("Résumé unique", { exact: true })).toBeVisible();
  await expect.poll(async () => (await runsOf(page, once))[0]?.outcome ?? "none", { timeout: 60_000 }).toMatch(/succeeded|failed|cancelled/);
  await expect(page.getByRole("listitem").filter({ hasText: "Résumé unique" }).getByText("Terminée")).toBeVisible();

  // The interval's first run (≈ 60 s after saving) starts a normal mission that ends.
  const done = /succeeded|failed|cancelled/;
  await expect.poll(async () => (await runsOf(page, minute?.id ?? ""))[0]?.outcome ?? "none", { timeout: 100_000, intervals: [2_000] }).toMatch(done);
  const [run] = await runsOf(page, minute?.id ?? "");
  expect(run?.outcome).toBe("succeeded");
  const events = await missionEvents(page, run?.missionId ?? "");
  expect(events.map((event) => event.type)).toEqual(expect.arrayContaining(["mission.created", "mission.plan", "mission.started", "mission.succeeded"]));
  await page.getByRole("button", { name: "Historique de Veille minute" }).click();
  const history = page.getByRole("region", { name: /Historique des exécutions — Veille minute/ });
  await expect(history.getByText("Réussie")).toBeVisible();
  await history.scrollIntoViewIfNeeded();
  await shot(page, "j2b-schedules-history");

  // Pause: the next due time passes without a second run.
  const [beforePause] = (await schedulesOf(page, workspaceId)).filter((item) => item.id === minute?.id);
  const nextDue = beforePause?.nextRunAt ?? Date.now() + 60_000;
  await page.getByRole("button", { name: "Mettre en pause Veille minute" }).click();
  await expect(page.getByRole("listitem").filter({ hasText: "Veille minute" }).getByText("En pause")).toBeVisible();
  const [paused] = (await schedulesOf(page, workspaceId)).filter((item) => item.id === minute?.id);
  expect(paused).toMatchObject({ state: "paused", nextRunAt: null });
  await shot(page, "j2b-schedules-paused");
  await page.waitForTimeout(Math.max(0, nextDue + 5_000 - Date.now()));
  expect(await runsOf(page, minute?.id ?? "")).toHaveLength(1);
});
