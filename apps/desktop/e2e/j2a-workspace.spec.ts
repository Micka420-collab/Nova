// J2-A journey (a): open a local folder, browse the tree, open a file in the editor, edit and save;
// an external change is detected (clean buffer reloads, dirty buffer asks — never overwritten).
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { makeUserDataDir, removeDir, type LaunchedNova } from "./fixtures";
import { launchOnFolder, shot, writeShopProject } from "./j2a-kit";
import { startMockOpenRouter, type MockOpenRouter } from "./mock-openrouter";

let mock: MockOpenRouter;
let userDataDir: string;
let project: string;
let nova: LaunchedNova | null = null;

test.beforeEach(async () => {
  mock = await startMockOpenRouter();
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

test("(a) open a folder, browse, edit and save; an external change is detected, never overwritten", async () => {
  nova = await launchOnFolder({ userDataDir, mock, folder: project });
  const { page } = nova;
  await expect(page.getByText("Projet détecté : javascript · npm test")).toBeVisible();
  await expect(page.getByRole("contentinfo", { name: "Barre d'état" })).toContainText("aucun changement");
  await shot(page, "j2a-01-folder-opened");

  // Tree: expand src/, open cart.js in the editor.
  const tree = page.getByRole("tree").first();
  await tree.getByRole("treeitem", { name: /^src/ }).click();
  await tree.getByRole("treeitem", { name: /cart\.js/ }).click();
  const editor = page.getByRole("textbox", { name: "Éditeur : cart.js" });
  await expect(editor).toBeVisible();
  await expect(editor).toContainText("return prices.length;");
  await shot(page, "j2a-02-editor-open");

  // Edit and save with Ctrl+S: the disk holds the new text.
  await editor.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("// relu dans NOVA\n");
  await expect(page.getByRole("tab", { name: /src\/cart\.js, non enregistré/ })).toBeVisible();
  await page.keyboard.press("ControlOrMeta+s");
  await expect(page.getByText("cart.js enregistré")).toBeVisible();
  await expect.poll(() => readFileSync(join(project, "src/cart.js"), "utf8")).toContain("// relu dans NOVA");
  // The status bar counts the saved file (Git status re-read on the file event).
  await expect(page.getByRole("contentinfo", { name: "Barre d'état" })).toContainText("1 fichier modifié");
  await shot(page, "j2a-03-editor-saved");

  // Clean buffer + external change: the editor shows the disk version.
  writeFileSync(join(project, "src/cart.js"), `${readFileSync(join(project, "src/cart.js"), "utf8")}// changé dehors 1\n`);
  await expect(editor).toContainText("// changé dehors 1");

  // Unsaved edits + external change: NOVA asks, the disk and the buffer are both kept.
  await editor.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("// ma version\n");
  writeFileSync(join(project, "src/cart.js"), `${readFileSync(join(project, "src/cart.js"), "utf8")}// changé dehors 2\n`);
  await expect(page.getByText("Le fichier a changé sur le disque")).toBeVisible();
  await expect(editor).toContainText("// ma version");
  expect(readFileSync(join(project, "src/cart.js"), "utf8")).toContain("// changé dehors 2");
  expect(readFileSync(join(project, "src/cart.js"), "utf8")).not.toContain("// ma version");
  // Ctrl+S never picks a side while the conflict is open.
  await page.keyboard.press("ControlOrMeta+s");
  expect(readFileSync(join(project, "src/cart.js"), "utf8")).not.toContain("// ma version");
  await shot(page, "j2a-04-external-conflict");

  await page.getByRole("button", { name: "Garder ma version" }).click();
  await expect.poll(() => readFileSync(join(project, "src/cart.js"), "utf8")).toContain("// ma version");
});
