// J2-A journey (b), acceptance scenarios 4 and 5 through the UI: a « Corriger » mission reads two
// files, asks before each edit (approved in the card), runs the project's real test command through
// run_tests (red before, green after) and ends with a proof. The review shows the mission's diff
// (equal to the disk), reverts one file, keeps the other; the user's own edits — made before the
// mission and during it — are never overwritten, and a file changed after the mission is not
// reverted over the user's back.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { makeUserDataDir, removeDir, type LaunchedNova } from "./fixtures";
import { CART_FIXED, currentWorkspaceId, latestMission, launchOnFolder, missionEvents, planFromAgent, shot, TERMINAL_EVENTS, writeShopProject } from "./j2a-kit";
import { startMockOpenRouter, type MissionScript, type MockOpenRouter, type ScriptStep } from "./mock-openrouter";

const FORMAT_USER =
  "// note de l'utilisateur : garder ce commentaire\nfunction euros(amount) {\n  return amount + \" EUR\";\n}\n\nmodule.exports = { euros };\n";
const FORMAT_USER_DURING = `${FORMAT_USER}// ajouté pendant la mission\n`;
const EUROS_NEW = 'return new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(amount);';

const tools = (...calls: { name: string; args: unknown }[]): ScriptStep => ({ kind: "tools", calls });

/** Reads both files, fixes the cart, formats euros (re-reading once if the user changed the file), runs the tests. */
const FIX_CART: MissionScript = {
  plan: {
    summary: "Je lis le panier, je corrige le total, je formate les euros puis je relance le test.",
    tasks: [{ title: "Le test du panier passe", acceptance: { kind: "test_passes", detail: "npm test" } }],
  },
  step({ results }) {
    const last = results.at(-1);
    const edited = (path: string) => results.some((result) => result.name === "edit_file" && result.content.startsWith(`Edited ${path}`));
    if (results.length === 0) return tools({ name: "read_file", args: { path: "src/cart.js" } }, { name: "read_file", args: { path: "src/format.js" } });
    if (!edited("src/cart.js")) {
      return tools({ name: "edit_file", args: { path: "src/cart.js", edits: [{ oldText: "return prices.length;", newText: "return prices.reduce((sum, price) => sum + price, 0);" }] } });
    }
    if (!edited("src/format.js")) {
      if (last?.name === "edit_file" && /changed since you last read it/.test(last.content)) return tools({ name: "read_file", args: { path: "src/format.js" } });
      return tools({ name: "edit_file", args: { path: "src/format.js", edits: [{ oldText: 'return amount + " EUR";', newText: EUROS_NEW }] } });
    }
    if (!results.some((result) => result.name === "run_tests")) return tools({ name: "run_tests", args: {} });
    return { kind: "answer", text: "Le total additionne maintenant les prix et le test `npm test` passe." };
  },
};

let mock: MockOpenRouter;
let userDataDir: string;
let project: string;
let nova: LaunchedNova | null = null;

test.beforeEach(async () => {
  mock = await startMockOpenRouter({ scripts: { "fix-cart": FIX_CART } });
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

const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

test("(b) Corriger: approvals in the UI, real test run as proof, review reverts one file and keeps the other, user edits kept", async () => {
  test.setTimeout(150_000);
  // Scenario 4: the test is really red before the mission.
  expect(() => execFileSync("npm", ["test"], { cwd: project, stdio: "pipe" })).toThrow();
  // Scenario 5: an uncommitted user change in a file the mission will touch.
  writeFileSync(join(project, "src/format.js"), FORMAT_USER);

  nova = await launchOnFolder({ userDataDir, mock, folder: project });
  const { page } = nova;
  const workspaceId = await currentWorkspaceId(page);
  await page.getByRole("button", { name: "Confier une mission à Nomi" }).click();
  await planFromAgent(page, "Corriger", "Le total du panier est faux [script:fix-cart]");
  await expect(page.getByRole("heading", { name: "Ce que Nomi peut faire seul pendant cette mission" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Titre de l'étape 1" })).toHaveValue("Le test du panier passe");
  await shot(page, "j2a-05-plan-contract");
  await page.getByRole("button", { name: "Lancer la mission" }).click();

  const agent = page.getByRole("region", { name: "Panneau Agent" });
  const approveOnce = agent.getByRole("button", { name: "Autoriser une fois" });

  // Edit of src/cart.js: the card says what, where and why.
  await expect(agent.getByText(/Nomi veut modifier/).last()).toBeVisible();
  await expect(agent.getByText("src/cart.js").last()).toBeVisible();
  await shot(page, "j2a-06-approval");
  await approveOnce.click();

  // Edit of src/format.js: meanwhile the user edits that file again. The approved write must not
  // overwrite it: the tool reports the conflict, Nomi re-reads, then asks again.
  await expect(approveOnce).toBeVisible();
  writeFileSync(join(project, "src/format.js"), FORMAT_USER_DURING);
  await approveOnce.click();
  await expect(approveOnce).toBeVisible();
  expect(readFileSync(join(project, "src/format.js"), "utf8")).toBe(FORMAT_USER_DURING);
  await approveOnce.click();

  // run_tests runs `npm test` for real; the mission ends with the proof.
  const end = agent.getByRole("region", { name: /Mission terminée/ });
  await expect(end).toBeVisible({ timeout: 60_000 });
  await expect(end).toContainText("Vérifié");
  await expect(end).toContainText("Le test du panier passe");
  // The proof is what ran: `npm test`, its exit code; counts node --test does not report stay absent.
  await expect(agent.getByText("Preuve : code 0")).toBeVisible();
  await expect(agent.getByRole("button", { name: /Tester npm test/ })).toBeVisible();
  await shot(page, "j2a-07-mission-succeeded");

  const mission = await latestMission(page, workspaceId);
  expect(mission.state).toBe("succeeded");
  const events = await missionEvents(page, mission.id);
  expect(events.filter((event) => TERMINAL_EVENTS.includes(event.type))).toHaveLength(1);
  const tests = events.filter((event) => event.type === "tool.finished" && (event as { display?: { kind?: string } }).display?.kind === "tests");
  expect(tests).toMatchObject([{ state: "succeeded", display: { kind: "tests", exitCode: 0 } }]);
  // Every executed tool had an allow decision first (no execution without a recorded allow).
  const audit = await page.evaluate(async (id) => {
    const listed = await window.novaBridge.audit.list({ workspaceId: null, missionId: id, actor: null, action: null, decision: null, operation: null, since: null, until: null, beforeSeq: null, limit: 200 });
    if (!listed.ok) throw new Error(listed.error.message);
    return listed.value.map((entry) => ({ action: entry.action, decision: entry.decision ?? null }));
  }, mission.id);
  expect(audit.filter((entry) => entry.action === "tool.executed").length).toBeGreaterThanOrEqual(5);
  expect(readFileSync(join(project, "src/cart.js"), "utf8")).toBe(CART_FIXED);
  expect(readFileSync(join(project, "src/format.js"), "utf8")).toBe(FORMAT_USER_DURING.replace('return amount + " EUR";', EUROS_NEW));
  execFileSync("npm", ["test"], { cwd: project, stdio: "pipe" });

  // The review document: two modified files; the diff is what is on disk (hash for hash).
  await end.getByRole("button", { name: "Relire les changements" }).click();
  const review = page.getByRole("region", { name: "Relecture des changements" });
  await expect(review).toBeVisible();
  await expect(review).toContainText("src/cart.js");
  await expect(review).toContainText("src/format.js");
  const diff = await page.evaluate(async (id) => {
    const result = await window.novaBridge.missions.diff({ missionId: id });
    if (!result.ok) throw new Error(result.error.message);
    return result.value.files.map((file) => ({ path: file.path, change: file.change, currentHash: file.currentHash }));
  }, mission.id);
  expect(diff.map((file) => file.path).sort()).toEqual(["src/cart.js", "src/format.js"]);
  for (const file of diff) expect(file.currentHash).toBe(sha256(join(project, file.path)));

  // Each file says it was verified by the test run that came after its change.
  const cartFile = review.getByRole("region", { name: "src/cart.js" });
  const formatFile = review.getByRole("region", { name: "src/format.js" });
  await expect(cartFile).toContainText("test passé");
  await expect(formatFile).toContainText("test passé");
  await shot(page, "j2a-08-review-diff");

  // After the mission the user touches cart.js: restoring it must not overwrite that edit.
  const cartAfterUser = `${CART_FIXED}// retouche après la mission\n`;
  writeFileSync(join(project, "src/cart.js"), cartAfterUser);
  await cartFile.getByRole("button", { name: "Restaurer" }).click();
  await expect(cartFile.getByText("Ce fichier a changé depuis la mission · rien n'a été écrasé.")).toBeVisible();
  expect(readFileSync(join(project, "src/cart.js"), "utf8")).toBe(cartAfterUser);

  // format.js goes back to exactly the user's version (both user edits, none of the mission's).
  await formatFile.getByRole("button", { name: "Restaurer" }).click();
  await expect.poll(() => readFileSync(join(project, "src/format.js"), "utf8")).toBe(FORMAT_USER_DURING);
  await expect(formatFile).toContainText("annulé");
  await shot(page, "j2a-09-review-conflict");

  // Keep cart.js: the fix and the user's later edit both stay.
  await cartFile.getByRole("button", { name: "Garder" }).click();
  await expect(cartFile).toContainText("gardé");
  expect(readFileSync(join(project, "src/cart.js"), "utf8")).toBe(cartAfterUser);
});
