// J2-B L1 journey: the agent terminal and background processes, through the UI, on the built app.
// A « Construire » mission (scripted by the OpenRouter mock) starts two servers in the background
// (each approved in its card), lists them and reads one's output (process_list / process_output),
// then asks to stop it (process_stop, approved in its card). Meanwhile the dock shows the server's
// agent session read-only (typing is refused) until « Prendre la main », after which the server
// receives what the user types. Quitting NOVA while the mission waits kills the other server:
// no orphan process.
// Requires the L1 wiring (processes service in main: toolDeps.commands/processes, harness.processes).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { makeUserDataDir, removeDir, type LaunchedNova } from "./fixtures";
import { currentWorkspaceId, latestMission, launchOnFolder, missionEvents, planFromAgent, shot, writeShopProject } from "./j2a-kit";
import { startMockOpenRouter, type MissionScript, type MockOpenRouter, type ScriptStep } from "./mock-openrouter";

/**
 * A tiny server: writes its pid, says it is ready, echoes every line it reads on its terminal and
 * appends it to `<pid file>.in`. What reached it is read from the disk, not from the screen: with the
 * WebGL renderer (macOS, Windows with a GPU) the terminal text is only pixels.
 */
const SERVER = [
  'const fs = require("node:fs");',
  "fs.writeFileSync(process.argv[2], String(process.pid));",
  'console.log("serveur pret");',
  'process.stdin.setEncoding("utf8");',
  'process.stdin.on("data", (data) => {',
  '  console.log("recu: " + data.trim());',
  '  fs.appendFileSync(process.argv[2] + ".in", data);',
  "});",
  "setInterval(() => {}, 1000);",
  "",
].join("\n");

const tools = (...calls: { name: string; args: unknown }[]): ScriptStep => ({ kind: "tools", calls });
const processIdIn = (content: string | undefined): string => /\[process ([0-9a-f-]{36})\]/.exec(content ?? "")?.[1] ?? "missing";

const DEV_SERVER: MissionScript = {
  plan: {
    summary: "Je lance deux serveurs en arrière-plan, je lis la sortie du premier puis je l’arrête.",
    tasks: [{ title: "Le serveur répond", acceptance: { kind: "manual", detail: "La sortie dit « serveur pret »." } }],
  },
  step({ results }) {
    const byName = (name: string) => results.filter((result) => result.name === name);
    const started = byName("run_command");
    const first = processIdIn(started[0]?.content);
    if (started.length === 0) return tools({ name: "run_command", args: { argv: ["node", "server.js", "a.pid"], background: true } });
    if (started.length === 1) return tools({ name: "run_command", args: { argv: ["node", "server.js", "b.pid"], background: true } });
    if (byName("process_list").length === 0) return tools({ name: "process_list", args: {} });
    if (byName("process_output").length === 0) return tools({ name: "process_output", args: { processId: first, maxChars: 2_000 } });
    if (byName("process_stop").length === 0) return tools({ name: "process_stop", args: { processId: first } });
    // Asks once more (never answered): the mission is still running when NOVA quits.
    return tools({ name: "run_command", args: { argv: ["node", "-e", "console.log('fin')"] } });
  },
};

let mock: MockOpenRouter;
let userDataDir: string;
let project: string;
let nova: LaunchedNova | null = null;
const pids: number[] = [];

test.beforeEach(async () => {
  mock = await startMockOpenRouter({ scripts: { "dev-server": DEV_SERVER } });
  userDataDir = makeUserDataDir();
  project = makeUserDataDir();
  writeShopProject(project);
  writeFileSync(join(project, "server.js"), SERVER);
});

test.afterEach(async () => {
  for (const pid of pids.splice(0)) if (alive(pid)) process.kill(pid, "SIGKILL");
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

function pidOf(name: string): number {
  const pid = Number(readFileSync(join(project, name), "utf8"));
  pids.push(pid);
  return pid;
}

/** What server B read on its terminal (its `.in` file). */
function receivedByB(): string {
  const path = join(project, "b.pid.in");
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

/** A process's recent output, through the same API as the « Processus » list. */
async function outputOf(page: Page, processId: string): Promise<string> {
  return page.evaluate(async (id) => {
    const result = await window.novaBridge.processes.output({ processId: id, maxChars: 2_000 });
    if (!result.ok) throw new Error(result.error.message);
    return result.value.text;
  }, processId);
}

test("agent terminal: background servers read-only until « Prendre la main », process tools, no orphan at quit", async () => {
  test.setTimeout(150_000);
  nova = await launchOnFolder({ userDataDir, mock, folder: project });
  const { page } = nova;
  const workspaceId = await currentWorkspaceId(page);
  await page.getByRole("button", { name: "Confier une mission à Nomi" }).click();
  await planFromAgent(page, "Construire", "Lance le serveur de dev [script:dev-server]");
  await page.getByRole("button", { name: "Lancer la mission" }).click();

  const agent = page.getByRole("region", { name: "Panneau Agent" });
  const approveOnce = agent.getByRole("button", { name: "Autoriser une fois" });
  // Two background starts, each approved in its card (execute, not a routine command).
  await approveOnce.click();
  await expect.poll(() => existsSync(join(project, "a.pid")), { timeout: 20_000 }).toBe(true);
  await approveOnce.click();
  await expect.poll(() => existsSync(join(project, "b.pid")), { timeout: 20_000 }).toBe(true);
  const serverA = pidOf("a.pid");
  const serverB = pidOf("b.pid");
  expect(alive(serverA) && alive(serverB)).toBe(true);

  // process_list and process_output ran on their own (reads); process_stop now waits for approval.
  await expect(approveOnce).toBeVisible({ timeout: 30_000 });
  const mission = await latestMission(page, workspaceId);
  const listed = await page.evaluate(async (missionId) => {
    const result = await window.novaBridge.processes.list({ workspaceId: null, missionId });
    if (!result.ok) throw new Error(result.error.message);
    return result.value;
  }, mission.id);
  expect(listed.map((item) => ({ argv: item.argv, state: item.state, hosted: item.terminalSessionId !== null }))).toEqual([
    { argv: ["node", "server.js", "a.pid"], state: "running", hosted: true },
    { argv: ["node", "server.js", "b.pid"], state: "running", hosted: true },
  ]);

  // Server B is listening on its terminal (its output says so) before anything is typed.
  const processB = listed.find((item) => item.argv.at(-1) === "b.pid")?.id ?? "missing";
  await expect.poll(() => outputOf(page, processB)).toContain("serveur pret");

  // The dock shows server B's agent session, read-only: typing reaches nothing.
  await page.keyboard.press("Control+j");
  const panel = page.getByRole("region", { name: "Terminal", exact: true });
  await expect(panel).toBeVisible();
  await panel.getByRole("tab", { name: /server\.js b\.pid/ }).click();
  await expect(panel.getByText(/Session de Nomi en lecture seule/)).toBeVisible();
  const view = panel.locator(".nv-terminal-view:not([hidden])");
  await view.click();
  await page.keyboard.type("ignore\n");
  await page.waitForTimeout(1_000);
  expect(receivedByB()).toBe("");
  await shot(page, "j2b-l1-01-agent-terminal-read-only");

  // « Prendre la main »: the session is the user's (server B leaves the mission), the server
  // receives the line, and only that one.
  await panel.getByRole("button", { name: "Prendre la main" }).click();
  await expect(panel.getByText(/Session de Nomi en lecture seule/)).toHaveCount(0);
  await view.click();
  await page.keyboard.type("bonjour\n");
  await expect.poll(receivedByB).toContain("bonjour");
  expect(receivedByB()).not.toContain("ignore");
  await shot(page, "j2b-l1-02-agent-terminal-taken-over");

  // process_stop, approved: server A (its whole tree) is gone and the card says so.
  await approveOnce.click();
  await expect.poll(() => alive(serverA), { timeout: 15_000 }).toBe(false);
  // The call's card opens on its result; the processes list says the same.
  await agent.getByRole("button", { name: /^Arrêter le processus node server\.js a\.pid/ }).click();
  await expect(agent.getByText("Processus arrêté").first()).toBeVisible();
  await expect(agent.getByRole("region", { name: "Processus en arrière-plan" }).getByText("Arrêté").first()).toBeVisible();
  const events = await missionEvents(page, mission.id);
  const ended = events.filter((event) => event.type === "process.ended") as unknown as { process: { argv: string[]; state: string } }[];
  // B was handed over to the user (journaled for the mission), A stopped by the mission.
  expect(ended.map((event) => [event.process.argv.at(-1), event.process.state])).toEqual([
    ["b.pid", "handed_over"],
    ["a.pid", "stopped"],
  ]);
  expect(events.filter((event) => event.type === "process.started")).toHaveLength(2);
  expect(events.filter((event) => event.type === "tool.terminal").length).toBeGreaterThanOrEqual(2);
  const output = events.find((event) => event.type === "tool.finished" && (event as { display?: { action?: string } }).display?.action === "output") as
    | { display: { outputTail: string } }
    | undefined;
  expect(output?.display.outputTail).toContain("serveur pret");

  // The mission now waits on another approval; its end would spare B (the user's now), but quitting
  // NOVA must not leave it behind. Quitting asks first (the mission runs); « Quitter quand même ».
  await expect(approveOnce).toBeVisible({ timeout: 30_000 });
  expect(alive(serverB)).toBe(true);
  const app = nova.app;
  await app.evaluate(({ dialog }) => {
    const asked: string[] = [];
    (globalThis as { novaQuitQuestions?: string[] }).novaQuitQuestions = asked;
    dialog.showMessageBox = ((...args: unknown[]) => {
      asked.push((args.at(-1) as { detail?: string }).detail ?? "");
      // Answered once the test has read the question (the app exits right after).
      return new Promise((resolve) => {
        (globalThis as { novaQuitAnswer?: () => void }).novaQuitAnswer = () => resolve({ response: 1, checkboxChecked: false });
      });
    }) as typeof dialog.showMessageBox;
  });
  await app.evaluate(({ app: electronApp }) => electronApp.quit());
  await expect.poll(() => app.evaluate(() => (globalThis as { novaQuitQuestions?: string[] }).novaQuitQuestions ?? [])).toHaveLength(1);
  const question = (await app.evaluate(() => (globalThis as { novaQuitQuestions?: string[] }).novaQuitQuestions?.[0])) ?? "";
  expect(question).toContain("1 mission en cours");
  expect(question).toContain("1 approbation en attente");
  // Server B is the user's now: not a mission process, and no line for the open terminal.
  expect(question).not.toContain("processus");
  expect(question).not.toContain("terminal");
  const closed = app.waitForEvent("close", { timeout: 20_000 });
  await app.evaluate(() => (globalThis as { novaQuitAnswer?: () => void }).novaQuitAnswer?.()).catch(() => undefined);
  await closed;
  nova = null;
  await expect.poll(() => alive(serverB), { timeout: 15_000 }).toBe(false);
});
