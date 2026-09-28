// J2-A journey (e): the terminal of the atelier is a real shell (node-pty in the pty-host worker) in
// the project folder: a command runs there, Ctrl+C interrupts a running program (the process is
// really gone), and the shell keeps working afterwards. Quitting with only an idle shell open asks
// nothing (the quit warning is about missions, their processes and schedules).
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { makeUserDataDir, removeDir, type LaunchedNova } from "./fixtures";
import { launchOnFolder, shot, writeShopProject } from "./j2a-kit";
import { startMockOpenRouter, type MockOpenRouter } from "./mock-openrouter";

let mock: MockOpenRouter;
let userDataDir: string;
let project: string;
let nova: LaunchedNova | null = null;
let spawnedPid: number | null = null;

test.beforeEach(async () => {
  mock = await startMockOpenRouter();
  userDataDir = makeUserDataDir();
  project = makeUserDataDir();
  writeShopProject(project);
});

test.afterEach(async () => {
  if (spawnedPid !== null && alive(spawnedPid)) process.kill(spawnedPid, "SIGKILL");
  spawnedPid = null;
  if (nova) {
    // A failed test must not hang its teardown on the quit question: answer « Quitter quand même ».
    await nova.app
      .evaluate(({ dialog }) => {
        dialog.showMessageBox = (() => Promise.resolve({ response: 1, checkboxChecked: false })) as typeof dialog.showMessageBox;
      })
      .catch(() => {});
    await nova.app.close().catch(() => {});
  }
  nova = null;
  await mock.close();
  removeDir(userDataDir);
  removeDir(project);
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Runs `node -e <code>` in the terminal: the same line works in every shell NOVA opens (bash, zsh,
 * pwsh, cmd). What the command did is read from the disk, not from the screen: with the WebGL
 * renderer the terminal text is only pixels.
 */
async function runNode(page: Page, code: string): Promise<void> {
  await page.keyboard.type(`node -e "${code}"\n`);
}

test("(e) terminal: a command runs in the project folder, Ctrl+C stops a running program", async () => {
  nova = await launchOnFolder({ userDataDir, mock, folder: project });
  const { page } = nova;

  // Ctrl+J shows the dock; its Terminal tab opens a shell in the project.
  await page.keyboard.press("ControlOrMeta+j");
  const panel = page.getByRole("region", { name: "Terminal" });
  await expect(panel).toBeVisible();
  const empty = panel.getByRole("button", { name: "Nouveau terminal" });
  if (await empty.first().isVisible()) await empty.first().click();
  const session = panel.getByRole("region", { name: /^Terminal 1 : / });
  await expect(session).toBeVisible();
  await session.click();

  await runNode(page, "require('fs').writeFileSync('cwd.txt', process.cwd())");
  await expect.poll(() => existsSync(join(project, "cwd.txt"))).toBe(true);
  // Native realpath: macOS /var is /private/var, Windows tmp paths can be 8.3 short names.
  expect(realpathSync.native(readFileSync(join(project, "cwd.txt"), "utf8"))).toBe(realpathSync.native(project));
  await shot(page, "j2a-14-terminal-command");

  // A program that never ends: it writes its pid, then waits. Ctrl+C must kill it.
  await runNode(page, "require('fs').writeFileSync('pid.txt', String(process.pid)); setInterval(() => {}, 1000)");
  await expect.poll(() => existsSync(join(project, "pid.txt"))).toBe(true);
  spawnedPid = Number(readFileSync(join(project, "pid.txt"), "utf8"));
  expect(alive(spawnedPid)).toBe(true);
  await page.keyboard.press("Control+c");
  await expect.poll(() => alive(spawnedPid ?? 0), { timeout: 10_000 }).toBe(false);

  // The shell survived the interrupt and still runs commands. Keys typed while it redraws its
  // prompt after the interrupt can be lost (pwsh then waits on a half line): like a user, clear the
  // line with Ctrl+C and type the command again.
  const after = join(project, "after.txt");
  for (let attempt = 0; attempt < 3 && !existsSync(after); attempt += 1) {
    if (attempt > 0) await page.keyboard.press("Control+c");
    await page.waitForTimeout(500);
    await runNode(page, "require('fs').writeFileSync('after.txt', 'ok')");
    await expect.poll(() => existsSync(after), { timeout: 5_000 }).toBe(true).catch(() => undefined);
  }
  expect(existsSync(after)).toBe(true);
  await expect(panel.getByRole("tab", { name: /En cours/ }).first()).toBeVisible();
  await shot(page, "j2a-15-terminal-interrupted");

  // Quitting with only this idle shell open asks nothing: NOVA closes. (A question here would be
  // answered « Annuler » and NOVA would stay open.)
  const app = nova.app;
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = (() => Promise.resolve({ response: 0, checkboxChecked: false })) as typeof dialog.showMessageBox;
  });
  const closed = app.waitForEvent("close", { timeout: 20_000 });
  await app.evaluate(({ app: electronApp }) => electronApp.quit()).catch(() => undefined);
  await closed;
  nova = null;
});
