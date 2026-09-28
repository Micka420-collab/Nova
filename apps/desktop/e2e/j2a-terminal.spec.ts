// J2-A journey (e): the terminal of the atelier is a real shell (node-pty in the pty-host worker) in
// the project folder: a command runs and prints, Ctrl+C interrupts a running program (the process
// is really gone), and the shell keeps working afterwards.
import { existsSync, readFileSync } from "node:fs";
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
  await nova?.app.close().catch(() => {});
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

/** Visible text of the terminal (xterm DOM rows, or its accessibility buffer with a canvas renderer). */
async function screenText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const view = document.querySelector(".nv-terminal-view:not([hidden])");
    const rows = view?.querySelector(".xterm-rows");
    const a11y = view?.querySelector(".xterm-accessibility-tree");
    return `${rows?.textContent ?? ""}\n${a11y?.textContent ?? ""}`;
  });
}

test("(e) terminal: a command runs in the project folder, Ctrl+C stops a running program", async () => {
  nova = await launchOnFolder({ userDataDir, mock, folder: project });
  const { page } = nova;

  // Ctrl+J shows the dock; its Terminal tab opens a shell in the project.
  await page.keyboard.press("Control+j");
  const panel = page.getByRole("region", { name: "Terminal" });
  await expect(panel).toBeVisible();
  const empty = panel.getByRole("button", { name: "Nouveau terminal" });
  if (await empty.first().isVisible()) await empty.first().click();
  const session = panel.getByRole("region", { name: /^Terminal 1 : / });
  await expect(session).toBeVisible();
  await session.click();

  await page.keyboard.type("pwd; echo NOVA_$((6*7))\n");
  await expect.poll(() => screenText(page)).toContain("NOVA_42");
  expect(await screenText(page)).toContain(project);
  await shot(page, "j2a-14-terminal-command");

  // A program that never ends: it writes its pid, then waits. Ctrl+C must kill it.
  await page.keyboard.type(`node -e "require('fs').writeFileSync('pid.txt', String(process.pid)); setInterval(() => {}, 1000)"\n`);
  await expect.poll(() => existsSync(join(project, "pid.txt"))).toBe(true);
  spawnedPid = Number(readFileSync(join(project, "pid.txt"), "utf8"));
  expect(alive(spawnedPid)).toBe(true);
  await page.keyboard.press("Control+c");
  await expect.poll(() => alive(spawnedPid ?? 0), { timeout: 10_000 }).toBe(false);

  // The shell is still there and saw the interrupt (exit status 130 = SIGINT).
  await page.keyboard.type("echo apres-$?\n");
  await expect.poll(() => screenText(page)).toContain("apres-130");
  await expect(panel.getByRole("tab", { name: /En cours/ }).first()).toBeVisible();
  await shot(page, "j2a-15-terminal-interrupted");
});
