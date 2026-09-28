// J2-B L4 journey: a « Corriger » mission with the « Chaîne » option on. The scripted model sends
// ONE run_chain program that reads two files then edits one of them. The edit asks in the card like
// a direct call, the three calls appear under the run_chain card, the audit log holds the three
// executions, and the file really changed only after the approval. Requires the integrator wiring
// (chain-host build entry, toolDeps.chain, ChainOption in the contract sheet, nesting in the timeline).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { makeUserDataDir, removeDir, type LaunchedNova } from "./fixtures";
import { auditOf, CART_BUGGY, CART_FIXED, currentWorkspaceId, latestMission, launchOnFolder, missionEvents, planFromAgent, shot, writeShopProject } from "./j2a-kit";
import { startMockOpenRouter, type MissionScript, type MockOpenRouter } from "./mock-openrouter";

const PROGRAM = [
  "const cart = await nova.read_file({ path: 'src/cart.js' });",
  "const format = await nova.read_file({ path: 'src/format.js' });",
  "console.log('lus :', cart.length > 0, format.length > 0);",
  "await nova.edit_file({ path: 'src/cart.js', edits: [{ oldText: 'return prices.length;', newText: 'return prices.reduce((sum, price) => sum + price, 0);' }] });",
  "return { edited: 'src/cart.js' };",
].join("\n");

const CHAIN_FIX: MissionScript = {
  plan: {
    summary: "Je lis le panier et le formatage en un seul programme, puis je corrige le total.",
    tasks: [{ title: "Le total additionne les prix", acceptance: { kind: "manual", detail: "src/cart.js additionne les prix." } }],
  },
  step({ results }) {
    if (!results.some((result) => result.name === "run_chain")) return { kind: "tools", calls: [{ name: "run_chain", args: { program: PROGRAM } }] };
    return { kind: "answer", text: "Le programme a lu les deux fichiers et corrigé le total." };
  },
};

let mock: MockOpenRouter;
let userDataDir: string;
let project: string;
let nova: LaunchedNova | null = null;

test.beforeEach(async () => {
  mock = await startMockOpenRouter({ scripts: { chain: CHAIN_FIX } });
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

test("« Chaîne »: one program, three gated calls under its card, approval in the card, audited", async () => {
  test.setTimeout(120_000);
  nova = await launchOnFolder({ userDataDir, mock, folder: project });
  const { page } = nova;
  const workspaceId = await currentWorkspaceId(page);
  await page.getByRole("button", { name: "Confier une mission à Nomi" }).click();
  await planFromAgent(page, "Corriger", "Corrige le total du panier [script:chain]");

  // The contract explains the option; it is off until the user turns it on.
  const option = page.getByRole("switch", { name: "Mode « Chaîne »" });
  await expect(option).toBeVisible();
  await expect(option).not.toBeChecked();
  await expect(page.getByText(/reste soumis à tes règles et à tes approbations/)).toBeVisible();
  await option.click();
  await expect(option).toBeChecked();
  await shot(page, "j2b-chain-01-contract");
  await page.getByRole("button", { name: "Lancer la mission" }).click();

  // The program's edit asks like a direct call; nothing is written before the answer.
  const agent = page.getByRole("region", { name: "Panneau Agent" });
  const approveOnce = agent.getByRole("button", { name: "Autoriser une fois" });
  await expect(approveOnce).toBeVisible({ timeout: 30_000 });
  await expect(agent.getByText("src/cart.js").last()).toBeVisible();
  expect(readFileSync(join(project, "src/cart.js"), "utf8")).toBe(CART_BUGGY);
  await shot(page, "j2b-chain-02-approval");
  await approveOnce.click();

  await expect(agent.locator(".nova-endcard")).toBeVisible({ timeout: 60_000 });
  // The program's card opens on its result; its calls are listed under it either way.
  await agent.getByRole("button", { name: /^Enchaîner/ }).click();
  await expect(agent.getByText("Programme terminé · 3 appels d’outil", { exact: false })).toBeVisible();
  await expect(agent.getByRole("list", { name: "3 appels de ce programme" })).toBeVisible();
  await shot(page, "j2b-chain-03-nested");
  expect(readFileSync(join(project, "src/cart.js"), "utf8")).toBe(CART_FIXED);

  // The log: the three calls are children of the run_chain call; the program is journaled.
  const mission = await latestMission(page, workspaceId);
  const events = await missionEvents(page, mission.id);
  const requested = events.flatMap((event) =>
    event.type === "tool.requested" ? [(event as unknown as { call: { id: string; name: string; parentCallId?: string | null } }).call] : [],
  );
  const parent = requested.find((call) => call.name === "run_chain");
  expect(parent).toBeDefined();
  expect(requested.filter((call) => call.parentCallId === parent!.id).map((call) => call.name)).toEqual(["read_file", "read_file", "edit_file"]);
  expect(events.filter((event) => event.type.startsWith("chain.")).map((event) => event.type)).toEqual(["chain.started", "chain.finished"]);
  expect(events.find((event) => event.type === "chain.finished")).toMatchObject({ summary: { state: "succeeded", toolCalls: 3 } });

  // The audit log holds the three executions of the program (plus the run_chain call itself).
  const executed = (await auditOf(page, mission.id)).filter((row) => row.action === "tool.executed").map((row) => row.tool);
  expect(executed.filter((tool) => tool === "read_file")).toHaveLength(2);
  expect(executed.filter((tool) => tool === "edit_file")).toHaveLength(1);
  expect(executed).toContain("run_chain");

  // The model received the program's outcome as the run_chain result.
  const chainResult = mock.requests
    .flatMap((request) => ((request.body as { messages?: { role: string; content: string | null }[] } | null)?.messages ?? []))
    .find((message) => message.role === "tool" && (message.content ?? "").includes("The program finished after 3 tool calls"));
  expect(chainResult).toBeDefined();
});
