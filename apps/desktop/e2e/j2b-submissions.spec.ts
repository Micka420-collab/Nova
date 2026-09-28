// J2-B L5 journey: a « Construire » mission with « Sous-missions » on delegates two sub-missions,
// one read-only (understand) and one that writes (fix). The UI shows the tree under the mission;
// the writer works in its own worktree (the project is untouched), ends « en attente
// d’intégration », and « Intégrer » runs the project's tests on the worktree then writes the fix
// into the project. The reader has nothing to integrate. No worktree is left behind.
// Requires the integrator wiring (toolDeps.submissions + per-mission tool routing, harness.submissions,
// SubMissionsOption in the contract sheet, SubmissionTree in the mission card, mission events fed
// to the controller and the store).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { makeUserDataDir, removeDir, type LaunchedNova } from "./fixtures";
import { CART_BUGGY, CART_FIXED, currentWorkspaceId, launchOnFolder, missionEvents, planFromAgent, shot, writeShopProject } from "./j2a-kit";
import { startMockOpenRouter, type MissionScript, type MockOpenRouter } from "./mock-openrouter";

const DELEGATE: MissionScript = {
  plan: {
    summary: "Je confie la lecture du formatage et la correction du total à deux sous-missions.",
    tasks: [{ title: "Déléguer", acceptance: { kind: "manual", detail: "Deux sous-missions lancées." } }],
  },
  step({ results }) {
    if (!results.some((result) => result.name === "start_submission")) {
      return {
        kind: "tools",
        calls: [
          { name: "start_submission", args: { title: "Lire le formatage", goal: "Explique src/format.js [script:sub-reader]", mode: "understand", budgetUsd: 0.05 } },
          { name: "start_submission", args: { title: "Corriger le total", goal: "Corrige total() dans src/cart.js [script:sub-writer]", mode: "fix", budgetUsd: 0.1 } },
        ],
      };
    }
    return { kind: "answer", text: "Les deux sous-missions sont lancées." };
  },
};

const READER: MissionScript = {
  plan: { summary: "Je lis le fichier.", tasks: [{ title: "Lire", acceptance: { kind: "manual", detail: "Lu." } }] },
  step({ results }) {
    if (!results.some((result) => result.name === "read_file")) return { kind: "tools", calls: [{ name: "read_file", args: { path: "src/format.js" } }] };
    return { kind: "answer", text: "euros() ajoute « EUR » au montant." };
  },
};

const WRITER: MissionScript = {
  plan: { summary: "Je corrige le total.", tasks: [{ title: "Corriger", acceptance: { kind: "manual", detail: "total additionne." } }] },
  step({ results }) {
    if (!results.some((result) => result.name === "read_file")) return { kind: "tools", calls: [{ name: "read_file", args: { path: "src/cart.js" } }] };
    if (!results.some((result) => result.name === "edit_file")) {
      return {
        kind: "tools",
        calls: [{ name: "edit_file", args: { path: "src/cart.js", edits: [{ oldText: "return prices.length;", newText: "return prices.reduce((sum, price) => sum + price, 0);" }] } }],
      };
    }
    return { kind: "answer", text: "total() additionne désormais les prix." };
  },
};

let mock: MockOpenRouter;
let userDataDir: string;
let project: string;
let nova: LaunchedNova | null = null;

test.beforeEach(async () => {
  mock = await startMockOpenRouter({ scripts: { delegate: DELEGATE, "sub-reader": READER, "sub-writer": WRITER } });
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

test("sub-missions: a tree of two children, the writer integrated after its tests, the reader not needed", async () => {
  test.setTimeout(180_000);
  nova = await launchOnFolder({ userDataDir, mock, folder: project });
  const { page } = nova;
  const workspaceId = await currentWorkspaceId(page);
  // Writes and the project's test command run without approvals here (the journey is about the tree).
  await page.evaluate(async (id) => {
    const saved = await window.novaBridge.permissions.setProfile({ workspaceId: id, profile: "autonomous" });
    if (!saved.ok) throw new Error(saved.error.message);
  }, workspaceId);

  await page.getByRole("button", { name: "Confier une mission à Nomi" }).click();
  await planFromAgent(page, "Construire", "Répartis le travail sur le panier [script:delegate]");
  const option = page.getByRole("switch", { name: "Sous-missions" });
  await expect(option).toBeVisible();
  await expect(option).not.toBeChecked();
  await option.click();
  await expect(page.getByRole("radiogroup", { name: "Nombre maximum de sous-missions" })).toBeVisible();
  await shot(page, "j2b-submissions-01-contract");
  await page.getByRole("button", { name: "Lancer la mission" }).click();

  const tree = page.getByRole("region", { name: "Sous-missions de cette mission" });
  await expect(tree).toBeVisible({ timeout: 60_000 });
  await expect(tree.getByText("Lire le formatage")).toBeVisible();
  await expect(tree.getByText("Corriger le total")).toBeVisible();
  await expect(tree.getByText("en attente d’intégration")).toBeVisible({ timeout: 90_000 });
  await expect(tree.getByText("rien à intégrer")).toBeVisible();
  await shot(page, "j2b-submissions-02-tree");
  // The writer changed its own copy only.
  expect(readFileSync(join(project, "src/cart.js"), "utf8")).toBe(CART_BUGGY);
  expect(readdirSync(join(userDataDir, "worktrees")).filter((name) => !name.startsWith("."))).toHaveLength(1);

  await tree.getByRole("button", { name: "Intégrer la sous-mission « Corriger le total » au projet" }).click();
  await expect(tree.getByText("intégrée", { exact: true })).toBeVisible({ timeout: 60_000 });
  await shot(page, "j2b-submissions-03-integrated");
  expect(readFileSync(join(project, "src/cart.js"), "utf8")).toBe(CART_FIXED);
  expect(readdirSync(join(userDataDir, "worktrees")).filter((name) => !name.startsWith("."))).toEqual([]);
  expect(existsSync(join(project, ".git", "worktrees")) ? readdirSync(join(project, ".git", "worktrees")) : []).toEqual([]);

  // The parent's journal: two starts, then the writer's integration steps.
  const parent = await page.evaluate(async (id) => {
    const list = await window.novaBridge.missions.list({ workspaceId: id, limit: 10 });
    if (!list.ok) throw new Error(list.error.message);
    return list.value.items.find((item) => item.title.startsWith("Répartis"))?.id ?? null;
  }, workspaceId);
  expect(parent).not.toBeNull();
  const events = await missionEvents(page, parent as string);
  expect(events.filter((event) => event.type === "submission.started")).toHaveLength(2);
  const integrations = events
    .filter((event) => event.type === "submission.updated")
    .map((event) => (event as unknown as { link: { integration: string | null } }).link.integration);
  expect(integrations).toEqual(expect.arrayContaining(["not_needed", "pending", "testing", "integrated"]));
});
