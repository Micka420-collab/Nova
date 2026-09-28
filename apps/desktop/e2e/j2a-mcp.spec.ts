// J2-A journey (f), acceptance scenario 8 (partial) and 7 (MCP part): a local stdio MCP server is
// added through the Extensions manager, its tools listed (a hostile description is shown as data),
// one tool is called by a mission after approval, a tool set to « Refuser » is never called, the
// server crashing mid-mission is visible and the mission ends with an explanation; a disabled
// server offers nothing to the model; a server that never answers ends « délai dépassé ».
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { makeUserDataDir, removeDir, type LaunchedNova } from "./fixtures";
import { auditOf, launchOnFolder, missionEvents, runMission, shot, TERMINAL_EVENTS, writeShopProject } from "./j2a-kit";
import { startMockOpenRouter, type MissionScript, type MockOpenRouter, type ScriptStep } from "./mock-openrouter";

// The SDK-based stdio fixture of @nova/mcp (Node strips its types; it resolves the SDK from there).
const SERVER = fileURLToPath(new URL("../../../packages/mcp/src/fixtures/test-server.ts", import.meta.url));
const tools = (...calls: { name: string; args: unknown }[]): ScriptStep => ({ kind: "tools", calls });

const USE_SERVER: MissionScript = {
  plan: { summary: "J'utilise le service de test.", tasks: [{ title: "Appeler le service", acceptance: { kind: "manual", detail: "" } }] },
  step({ results }) {
    if (results.length === 0) return tools({ name: "mcp__fixture__echo", args: { text: "bonjour NOVA" } });
    if (results.length === 1) return tools({ name: "mcp__fixture__env", args: { name: "HOME" } });
    if (results.length === 2) return tools({ name: "mcp__fixture__crash", args: {} });
    return { kind: "answer", text: "Le service de test s'est arrêté pendant l'appel ; je n'ai pas pu terminer." };
  },
};

/** After the server is disabled, the model still tries the old name: it must never reach it. */
const SERVER_OFF: MissionScript = {
  plan: { summary: "J'essaie encore le service.", tasks: [{ title: "Appeler le service", acceptance: { kind: "manual", detail: "" } }] },
  step({ results }) {
    if (results.length === 0) return tools({ name: "mcp__fixture__echo", args: { text: "encore" } });
    return { kind: "answer", text: "Le service n'est plus disponible." };
  },
};

let mock: MockOpenRouter;
let userDataDir: string;
let project: string;
let nova: LaunchedNova | null = null;

test.beforeEach(async () => {
  mock = await startMockOpenRouter({ scripts: { mcp: USE_SERVER, "mcp-off": SERVER_OFF } });
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

async function openExtensions(page: Page): Promise<void> {
  await page.getByRole("navigation", { name: "Espaces" }).getByRole("button", { name: "Extensions" }).click();
  await expect(page.getByRole("heading", { name: "Services connectés (MCP)" })).toBeVisible();
}

async function addStdioServer(page: Page, name: string, command: string, args: string[]): Promise<void> {
  await page.getByRole("button", { name: "Ajouter un serveur" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Ajouter un serveur MCP" });
  await dialog.getByRole("textbox", { name: "Nom" }).fill(name);
  await dialog.getByRole("textbox", { name: "Commande" }).fill(command);
  await dialog.getByRole("textbox", { name: "Arguments" }).fill(args.join("\n"));
  await dialog.getByRole("button", { name: "Enregistrer" }).click();
  await expect(dialog).toHaveCount(0);
}

function detail(page: Page, name: string) {
  return page.getByRole("region", { name });
}

test("(f) MCP: add a stdio server, list its tools, call one with approval, refuse one, see it crash, disable it, time out", async () => {
  test.setTimeout(240_000);
  nova = await launchOnFolder({ userDataDir, mock, folder: project });
  const { page } = nova;

  await openExtensions(page);
  await addStdioServer(page, "fixture", process.execPath, [SERVER]);
  const server = detail(page, "fixture");
  await server.getByRole("button", { name: "Tester la connexion" }).click();
  await expect(server.getByText("connecté", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(server.getByText("mcp__fixture__echo")).toBeVisible();
  // Scenario 7 (MCP part): the hostile description is framed as the server's text, flagged.
  await expect(server.getByText("Cette description contient des consignes adressées au modèle", { exact: false }).first()).toBeVisible();
  // M5: the `env` tool is refused for this project.
  await server.getByRole("radiogroup", { name: "Permission de env" }).getByRole("radio", { name: "Refuser" }).click();
  await expect(server.getByRole("radiogroup", { name: "Permission de env" }).getByRole("radio", { name: "Refuser" })).toBeChecked();
  await shot(page, "j2a-16-mcp-server");

  // A mission calls echo (approved), env (refused by the tool policy), then crash.
  const agent = page.getByRole("region", { name: "Panneau Agent" });
  const asked: string[] = [];
  const missionId = await runMission(page, "Corriger", "Utilise le service [script:mcp]", async (index) => {
    const card = agent.locator(".nv-approval:not(.nv-approval--decided)").first();
    asked.push(await card.innerText());
    if (index === 0) await shot(page, "j2a-17-mcp-approval");
    await card.getByRole("button", { name: "Autoriser une fois" }).click();
  });
  expect(asked).toHaveLength(2);
  expect(asked[0]).toContain("fixture › echo");
  expect(asked[1]).toContain("fixture › crash");
  await shot(page, "j2a-18-mcp-mission");

  const events = await missionEvents(page, missionId);
  expect(events.filter((event) => TERMINAL_EVENTS.includes(event.type))).toHaveLength(1);
  const finished = events.filter((event) => event.type === "tool.finished") as unknown as { callId: string; state: string; display: { kind: string; text?: string; code?: string } }[];
  expect(finished.map((event) => [event.state, event.display.kind, event.display.code ?? null])).toEqual([
    ["succeeded", "mcp", null],
    // A refused tool is not offered to the model at all: the call ends before any permission or run.
    ["failed", "error", "unavailable"],
    // The server died mid-call: a bounded, explained failure, not a hang.
    ["failed", "error", "unavailable"],
  ]);
  expect(finished[0]?.display).toMatchObject({ kind: "mcp", text: "bonjour NOVA" });
  const started = new Set(events.filter((event) => event.type === "tool.started").map((event) => (event as unknown as { callId: string }).callId));
  expect(started.has(finished[1]?.callId ?? "")).toBe(false);
  // What the model was offered: the server's tools by qualified name, except the refused one.
  const offered = mock.requests
    .flatMap((request) => (request.body ? [request.body as { tools?: { function?: { name?: string } }[]; messages?: unknown }] : []))
    .filter((body) => Array.isArray(body.tools) && JSON.stringify(body.messages).includes("[script:mcp]"))
    .map((body) => (body.tools ?? []).map((tool) => tool.function?.name ?? ""));
  expect(offered.length).toBeGreaterThan(0);
  for (const names of offered) {
    expect(names).toContain("mcp__fixture__echo");
    expect(names).not.toContain("mcp__fixture__env");
  }
  expect(events.some((event) => event.type === "mission.succeeded" || event.type === "mission.failed")).toBe(true);

  // The crash is visible in the manager.
  await openExtensions(page);
  const servers = page.getByRole("list", { name: "Serveurs MCP" });
  await expect(servers).toContainText("en erreur");
  await expect(servers).toContainText("Le serveur s'est arrêté.");
  await servers.getByText("fixture").click();
  await expect(server.getByText("en erreur", { exact: true })).toBeVisible();
  await shot(page, "j2a-19-mcp-after-crash");

  // Disabled: nothing of it is offered to the model, and the old name is never executed.
  await server.getByRole("button", { name: "Désactiver" }).click();
  await expect(server.getByText("désactivé", { exact: true })).toBeVisible();
  const before = mock.requests.length;
  const offId = await runMission(page, "Corriger", "Réessaie le service [script:mcp-off]", async () => {
    throw new Error("no approval expected for a disabled server");
  });
  const offTools = mock.requests
    .slice(before)
    .flatMap((request) => {
      const body = request.body as { tools?: { function?: { name?: string } }[] } | null;
      return body && Array.isArray(body.tools) ? [body.tools.map((tool) => tool.function?.name ?? "")] : [];
    });
  expect(offTools.length).toBeGreaterThan(0);
  for (const names of offTools) expect(names.filter((name) => name.startsWith("mcp__"))).toEqual([]);
  const offEvents = await missionEvents(page, offId);
  const offFinished = offEvents.filter((event) => event.type === "tool.finished") as unknown as { state: string }[];
  expect(offFinished.map((event) => event.state)).not.toContain("succeeded");
  expect((await auditOf(page, offId)).filter((row) => row.action === "tool.executed" && row.outcome === "succeeded")).toHaveLength(0);

  // A server that never answers: the connection test ends « délai dépassé », bounded.
  await openExtensions(page);
  await addStdioServer(page, "muet", process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
  const silent = detail(page, "muet");
  const testStarted = Date.now();
  await silent.getByRole("button", { name: "Tester la connexion" }).click();
  await expect(silent.getByText("injoignable (délai dépassé)")).toBeVisible({ timeout: 60_000 });
  expect(Date.now() - testStarted).toBeLessThan(60_000);
  await shot(page, "j2a-20-mcp-timeout");
});
