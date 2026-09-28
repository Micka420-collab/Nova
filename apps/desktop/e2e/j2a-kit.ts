// Shared setup of the J2-A acceptance journeys: a real project on disk (a small npm package with a
// bug and a failing `node --test`, under Git), the built app on the OpenRouter mock, a folder opened
// through the UI (only the native folder picker is replaced), and screenshots of key screens.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page } from "@playwright/test";
import type { NovaBridge } from "@nova/shared";
import { artifactsDir, launchNova, type LaunchedNova } from "./fixtures";
import { MOCK_KEYS, type MockOpenRouter } from "./mock-openrouter";

declare global {
  interface Window {
    novaBridge: NovaBridge;
  }
}

export const MODEL_ID = "deepseek/deepseek-v4-flash";

export const CART_BUGGY = "function total(prices) {\n  return prices.length;\n}\n\nmodule.exports = { total };\n";
export const CART_FIXED = "function total(prices) {\n  return prices.reduce((sum, price) => sum + price, 0);\n}\n\nmodule.exports = { total };\n";
export const CART_TEST =
  'const test = require("node:test");\nconst assert = require("node:assert");\nconst { total } = require("../src/cart");\n\n' +
  'test("total adds the prices", () => {\n  assert.strictEqual(total([2, 3]), 5);\n});\n';

function write(root: string, path: string, content: string): void {
  const full = join(root, path);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
}

/** The "shop" fixture: `npm test` (node --test) fails because `total` counts instead of adding. */
export function writeShopProject(root: string, options: { git?: boolean } = {}): void {
  write(
    root,
    "package.json",
    `${JSON.stringify({ name: "shop", version: "1.0.0", private: true, packageManager: "npm@10.9.0", scripts: { test: "node --test" } }, null, 2)}\n`,
  );
  write(root, "src/cart.js", CART_BUGGY);
  write(root, "src/format.js", 'function euros(amount) {\n  return amount + " EUR";\n}\n\nmodule.exports = { euros };\n');
  write(root, "test/cart.test.js", CART_TEST);
  write(root, "README.md", "# Shop\n\nUn petit panier d'exemple.\n");
  write(root, ".env", "PAYMENT_TOKEN=never-read-e2e\n");
  if (options.git !== false) {
    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "user.name=E2E", "-c", "user.email=e2e@example.invalid", "-c", "init.defaultBranch=main", ...args], {
        cwd: root,
        stdio: "ignore",
      });
    write(root, ".gitignore", ".env\nnode_modules/\n");
    git("init");
    git("add", "-A");
    git("commit", "-m", "shop");
  }
}

/** Finite animations (dialog/toast entrances, switch thumbs) are finished first: the capture shows the settled state. */
export async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: join(artifactsDir, "screens", `${name}.png`), animations: "disabled" });
}

/** Key (session) + default model through the bridge, then the UI reloads on that state. */
/**
 * Sets the key, loads the catalog and picks the default model. Unless `firstRun`, the first-run
 * profile question is answered too (profile « code », density « Tout » so every card shows).
 */
export async function connect(page: Page, options: { firstRun?: boolean } = {}): Promise<void> {
  await page.evaluate(
    async ({ apiKey, modelId, firstRun }) => {
      const saved = await window.novaBridge.connection.setKey({ providerId: "openrouter", apiKey, storage: "session" });
      if (!saved.ok) throw new Error(saved.error.message);
      const catalog = await window.novaBridge.models.catalog({ providerId: "openrouter", refresh: true });
      if (!catalog.ok) throw new Error(catalog.error.message);
      const onboarded = firstRun ? {} : { onboarding: { profile: "code" as const, completedAt: Date.now() }, display: { density: "all" as const } };
      const settings = await window.novaBridge.settings.update({ defaultModelId: modelId, ...onboarded });
      if (!settings.ok) throw new Error(settings.error.message);
    },
    { apiKey: MOCK_KEYS.valid, modelId: MODEL_ID, firstRun: options.firstRun === true },
  );
  await page.reload();
}

/** Launches NOVA, connects, and opens `folder` from Home (the native picker answers `folder`). */
export async function launchOnFolder(options: { userDataDir: string; mock: MockOpenRouter; folder: string }): Promise<LaunchedNova> {
  const nova = await launchNova({ userDataDir: options.userDataDir, mock: options.mock });
  await stubFolderPicker(nova, options.folder);
  await connect(nova.page);
  await nova.page.getByRole("region", { name: "Ouvrir un dossier" }).getByRole("button", { name: "Ouvrir un dossier…" }).click();
  await expect(nova.page.getByRole("treeitem", { name: /package\.json/ }).first()).toBeVisible();
  return nova;
}

export async function stubFolderPicker(nova: LaunchedNova, folder: string): Promise<void> {
  await nova.app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = (() => Promise.resolve({ canceled: false, filePaths: [path] })) as typeof dialog.showOpenDialog;
  }, folder);
}

/** The id of the workspace opened in the UI. */
export async function currentWorkspaceId(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const recent = await window.novaBridge.workspace.recent({ limit: 1 });
    if (!recent.ok || !recent.value[0]) throw new Error("no workspace");
    return recent.value[0].id;
  });
}

/** From the agent panel: pick a work mode, type the goal and ask for a plan. */
export async function planFromAgent(page: Page, mode: string, goal: string): Promise<void> {
  await page.getByRole("radiogroup", { name: "Mode de travail" }).getByRole("radio", { name: mode }).click();
  const input = page.getByRole("textbox", { name: "Objectif de la mission" });
  await input.fill(goal);
  await input.press("Enter");
  await expect(page.getByRole("button", { name: "Lancer la mission" })).toBeVisible();
}

/** Every event of a mission, oldest first (through the bridge, as the UI reads them). */
export async function missionEvents(page: Page, missionId: string): Promise<{ type: string; [key: string]: unknown }[]> {
  return page.evaluate(async (id) => {
    const detail = await window.novaBridge.missions.get({ missionId: id, afterSeq: 0 });
    if (!detail.ok) throw new Error(detail.error.message);
    return detail.value.events as unknown as { type: string; [key: string]: unknown }[];
  }, missionId);
}

/** The most recent mission of the workspace. */
export async function latestMission(page: Page, workspaceId: string): Promise<{ id: string; state: string }> {
  return page.evaluate(async (id) => {
    const list = await window.novaBridge.missions.list({ workspaceId: id, limit: 1 });
    if (!list.ok || !list.value.items[0]) throw new Error("no mission");
    const mission = list.value.items[0];
    return { id: mission.id, state: mission.state };
  }, workspaceId);
}

export const TERMINAL_EVENTS = ["mission.succeeded", "mission.failed", "mission.cancelled"];

export interface AuditRow {
  action: string;
  decision: string | null;
  target: string | null;
  outcome: string | null;
  tool: string | null;
  reason: string | null;
}

/** The audit log of a mission, oldest first (through the bridge, as the audit viewer reads it). */
export async function auditOf(page: Page, missionId: string): Promise<AuditRow[]> {
  const rows = await page.evaluate(async (id) => {
    const listed = await window.novaBridge.audit.list({
      workspaceId: null,
      missionId: id,
      actor: null,
      action: null,
      decision: null,
      operation: null,
      since: null,
      until: null,
      beforeSeq: null,
      limit: 500,
    });
    if (!listed.ok) throw new Error(listed.error.message);
    return listed.value.map((entry) => ({
      seq: entry.seq,
      action: entry.action,
      decision: entry.decision,
      target: entry.target,
      outcome: entry.outcome,
      tool: typeof entry.dataSummary?.["tool"] === "string" ? entry.dataSummary["tool"] : null,
      reason: typeof entry.dataSummary?.["reason"] === "string" ? entry.dataSummary["reason"] : null,
    }));
  }, missionId);
  return rows.sort((a, b) => a.seq - b.seq).map(({ seq: _seq, ...row }) => row);
}

/**
 * Runs a scripted mission from the agent panel until its end card shows; `onApproval` answers
 * each approval card (index = order of the card). Returns the mission id.
 */
export async function runMission(
  page: Page,
  mode: string,
  goal: string,
  onApproval: (index: number) => Promise<void>,
  options: { until?: "end" | "suspended" } = {},
): Promise<string> {
  const workspaceId = await currentWorkspaceId(page);
  await page.getByRole("navigation", { name: "Espaces" }).getByRole("button", { name: "Accueil" }).click();
  await page.getByRole("button", { name: "Confier une mission à Nomi" }).click();
  await planFromAgent(page, mode, goal);
  await page.getByRole("button", { name: "Lancer la mission" }).click();
  const agent = page.getByRole("region", { name: "Panneau Agent" });
  const done = options.until === "suspended" ? agent.getByText(/Mission suspendue/).first() : agent.locator(".nova-endcard");
  const pending = agent.locator(".nv-approval:not(.nv-approval--decided)");
  let approvals = 0;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (await done.isVisible()) break;
    if (await pending.first().isVisible()) {
      const id = await pending.first().getAttribute("id");
      await onApproval(approvals);
      approvals += 1;
      // Cards come one after the other: wait until THIS one is answered.
      if (id) await expect(agent.locator(`[id="${id}"]:not(.nv-approval--decided)`)).toHaveCount(0);
      continue;
    }
    await page.waitForTimeout(100);
  }
  await expect(done).toBeVisible();
  return (await latestMission(page, workspaceId)).id;
}
