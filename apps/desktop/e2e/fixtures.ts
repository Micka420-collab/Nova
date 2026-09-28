import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import type { MockOpenRouter } from "./mock-openrouter";

// resolve() drops the trailing separator: on Windows "…\desktop\" would escape the closing quote
// of the Electron command line and break the argument.
export const appDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
export const artifactsDir = join(appDir, "e2e", "artifacts");

export function makeUserDataDir(): string {
  return mkdtempSync(join(tmpdir(), "nova-e2e-"));
}

export function removeDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

export interface LaunchedNova {
  app: ElectronApplication;
  page: Page;
}

/** Launch the built app (out/) with an isolated data dir and the OpenRouter mock. */
export async function launchNova(options: {
  userDataDir: string;
  mock: MockOpenRouter;
  extraArgs?: string[];
}): Promise<LaunchedNova> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) if (value !== undefined) env[name] = value;
  env.NOVA_USER_DATA_DIR = options.userDataDir;
  env.NOVA_OPENROUTER_BASE_URL = options.mock.baseUrl;
  delete env.ELECTRON_RENDERER_URL;

  // CI/containers lack the setuid Chromium sandbox helper; the OS sandbox is disabled for tests only.
  const sandboxArgs = process.platform === "linux" ? ["--no-sandbox"] : [];
  const app = await electron.launch({
    args: [appDir, ...sandboxArgs, ...(options.extraArgs ?? [])],
    cwd: appDir,
    env,
    timeout: 45_000,
  });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  return { app, page };
}

/**
 * Kills NOVA the way a crash does and waits until it is gone, so the next launch gets the
 * single-instance lock. On Windows a lone TerminateProcess of the main process leaves NOVA
 * running (its window still answers), so the whole tree goes, commands NOVA started included.
 */
export async function crashNova(nova: LaunchedNova): Promise<void> {
  const main = nova.app.process();
  const exited = new Promise((done) => main.once("exit", done));
  if (process.platform === "win32" && main.pid) execFileSync("taskkill", ["/pid", String(main.pid), "/T", "/F"]);
  else main.kill("SIGKILL");
  await exited;
}

/** Concatenate every file under `dir` (binary-safe latin1) to search for leaked secrets. */
export function readTreeAsText(dir: string): string {
  let out = "";
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) out += readTreeAsText(full);
    else if (stat.size < 50 * 1024 * 1024) out += readFileSync(full).toString("latin1");
  }
  return out;
}
