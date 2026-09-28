// J2-B lane L3 (M8, scenario 9): install a skill from a folder (its content and declared
// permissions are visible BEFORE « Installer »), enable it for the project, a mission loads it with
// the `skill` tool (card « Skill chargée », `skill.loaded` in the journal, index in the system
// prompt), then uninstall it: no file, no row, no enablement left, and it is no longer offered.
//
// Mount point assumed (integrator): the Extensions document shows the Skills manager, either
// directly or behind a « Skills » tab.
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { makeUserDataDir, removeDir, type LaunchedNova } from "./fixtures";
import { launchOnFolder, missionEvents, runMission, shot, stubFolderPicker, writeShopProject } from "./j2a-kit";
import { startMockOpenRouter, type MissionScript, type MockOpenRouter } from "./mock-openrouter";

const SKILL_NAME = "notes-de-projet";
const SKILL_REF = `user:${SKILL_NAME}`;
const SKILL_MD = [
  "---",
  `name: ${SKILL_NAME}`,
  "description: Write short project notes as bullet points, citing the files read.",
  "allowed-tools: read_file glob",
  "hosts: [api.example.com]",
  "---",
  "# Project notes",
  "Read the README, then write at most five bullet points. See references/format.md.",
  "",
].join("\n");

const LOAD_SKILL: MissionScript = {
  plan: { summary: "Je suis la skill de notes.", tasks: [{ title: "Écrire les notes", acceptance: { kind: "manual", detail: "" } }] },
  step({ results }) {
    if (results.length === 0) return { kind: "tools", calls: [{ name: "skill", args: { ref: SKILL_REF } }] };
    if (results.length === 1) return { kind: "tools", calls: [{ name: "skill", args: { ref: SKILL_REF, path: "references/format.md" } }] };
    return { kind: "answer", text: "- Un panier d'exemple (README.md)." };
  },
};

const AFTER_UNINSTALL: MissionScript = {
  plan: { summary: "J'essaie encore la skill.", tasks: [{ title: "Écrire les notes", acceptance: { kind: "manual", detail: "" } }] },
  step({ results }) {
    if (results.length === 0) return { kind: "tools", calls: [{ name: "skill", args: { ref: SKILL_REF } }] };
    return { kind: "answer", text: "La skill n'est plus disponible." };
  },
};

let mock: MockOpenRouter;
let userDataDir: string;
let project: string;
let skillSource: string;
let nova: LaunchedNova | null = null;

test.beforeEach(async () => {
  mock = await startMockOpenRouter({ scripts: { skill: LOAD_SKILL, "skill-gone": AFTER_UNINSTALL } });
  userDataDir = makeUserDataDir();
  project = makeUserDataDir();
  writeShopProject(project);
  skillSource = join(makeUserDataDir(), SKILL_NAME);
  mkdirSync(join(skillSource, "references"), { recursive: true });
  writeFileSync(join(skillSource, "SKILL.md"), SKILL_MD);
  writeFileSync(join(skillSource, "references", "format.md"), "One line per bullet, file path in parentheses.\n");
});

test.afterEach(async () => {
  await nova?.app.close().catch(() => {});
  nova = null;
  await mock.close();
  removeDir(userDataDir);
  removeDir(project);
  removeDir(join(skillSource, ".."));
});

async function openSkills(page: Page): Promise<void> {
  await page.getByRole("navigation", { name: "Espaces" }).getByRole("button", { name: "Extensions" }).click();
  const tab = page.getByRole("tab", { name: "Skills" });
  if ((await tab.count()) > 0) await tab.click();
  await expect(page.getByRole("heading", { name: "Skills", level: 1 })).toBeVisible();
}

/** The system prompts of the mission loop (requests offering tools, not the planner) for `marker`. */
function systemPrompts(marker: string): string[] {
  return mock.requests
    .flatMap((request) => (request.body ? [request.body as { tools?: unknown[]; messages?: { role: string; content: string | null }[] }] : []))
    .filter((body) => Array.isArray(body.tools) && JSON.stringify(body.messages ?? []).includes(marker))
    .map((body) => body.messages?.find((message) => message.role === "system")?.content ?? "");
}

test("(L3) skills: preview then install, enable for the project, loaded by a mission, uninstalled without residue", async () => {
  test.setTimeout(180_000);
  nova = await launchOnFolder({ userDataDir, mock, folder: project });
  const { page } = nova;

  await openSkills(page);
  // Shipped skills are listed, none enabled.
  await expect(page.getByRole("listitem", { name: "Comprendre un dépôt" })).toBeVisible();

  // Install: the native picker answers the skill folder; the preview shows everything first.
  await stubFolderPicker(nova, skillSource);
  await page.getByRole("button", { name: "Installer depuis un dossier…" }).click();
  const preview = page.getByRole("dialog", { name: "Aperçu avant installation" });
  await expect(preview.getByText(/at most five bullet points/)).toBeVisible();
  await expect(preview.getByText("api.example.com").first()).toBeVisible();
  await expect(preview.getByText("references/format.md", { exact: true })).toBeVisible();
  await expect(preview.getByText(/n'accordent aucun droit/)).toBeVisible();
  await shot(page, "j2b-l3-01-skill-preview");
  await preview.getByRole("button", { name: "Installer" }).click();
  await expect(preview).toHaveCount(0);
  const row = page.getByRole("listitem", { name: SKILL_NAME });
  await expect(row).toBeVisible();
  const installedDir = join(userDataDir, "skills", SKILL_NAME);
  expect(readdirSync(join(userDataDir, "skills"))).toEqual([SKILL_NAME]);

  // Enable it for the open project.
  await row.getByRole("switch").click();
  await expect(row.getByRole("switch")).toHaveAttribute("aria-checked", "true");
  await shot(page, "j2b-l3-02-skill-enabled");

  // A mission loads it (SKILL.md, then one reference): read-only mode is enough.
  const missionId = await runMission(page, "Comprendre", "Écris des notes [script:skill]", async () => {
    throw new Error("loading a skill never asks for approval");
  });
  const agent = page.getByRole("region", { name: "Panneau Agent" });
  // Tool cards open on demand: the first one is the SKILL.md load.
  await agent.getByRole("button", { name: /Charger une skill/ }).first().click();
  await expect(agent.getByText(`Skill « ${SKILL_NAME} » chargée`).first()).toBeVisible();
  await shot(page, "j2b-l3-03-skill-loaded");
  const events = await missionEvents(page, missionId);
  expect(events.filter((event) => event.type === "skill.loaded").map((event) => [event["ref"], event["path"]])).toEqual([
    [SKILL_REF, null],
    [SKILL_REF, "references/format.md"],
  ]);
  const toolResults = mock.requests.map((request) => JSON.stringify(request.body)).join("\n");
  expect(toolResults).toContain("One line per bullet");
  const prompts = systemPrompts("[script:skill]");
  expect(prompts.length).toBeGreaterThan(0);
  for (const prompt of prompts) expect(prompt).toContain(`- ${SKILL_REF} (${SKILL_NAME}): Write short project notes`);

  // Uninstall: folder, row and enablement gone; the next mission no longer sees it.
  await openSkills(page);
  await page.getByRole("listitem", { name: SKILL_NAME }).getByRole("button", { name: "Désinstaller" }).click();
  await page.getByRole("dialog", { name: `Désinstaller « ${SKILL_NAME} » ?` }).getByRole("button", { name: "Désinstaller" }).click();
  await expect(page.getByRole("listitem", { name: SKILL_NAME })).toHaveCount(0);
  expect(existsSync(installedDir)).toBe(false);
  expect(readdirSync(join(userDataDir, "skills"))).toEqual([]);
  const remaining = await page.evaluate(async () => {
    const recent = await window.novaBridge.workspace.recent({ limit: 1 });
    const workspaceId = recent.ok ? (recent.value[0]?.id ?? null) : null;
    const listed = await window.novaBridge.skills.list({ workspaceId });
    return listed.ok ? listed.value.filter((skill) => skill.scope !== "builtin").map((skill) => skill.ref) : ["error"];
  });
  expect(remaining).toEqual([]);

  const goneId = await runMission(page, "Comprendre", "Encore des notes [script:skill-gone]", async () => {
    throw new Error("no approval expected");
  });
  const goneEvents = await missionEvents(page, goneId);
  expect(goneEvents.some((event) => event.type === "skill.loaded")).toBe(false);
  const finished = goneEvents.find((event) => event.type === "tool.finished") as { display?: { kind: string; code?: string } } | undefined;
  expect(finished?.display).toMatchObject({ kind: "error", code: "not_found" });
  for (const prompt of systemPrompts("[script:skill-gone]")) expect(prompt).not.toContain(SKILL_REF);
  await shot(page, "j2b-l3-04-skill-uninstalled");
});
