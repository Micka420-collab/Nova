// J2-B lane L7: desktop presence, first-run choices, chat autopilot and pasted images.
// - First run: the profile and density chosen in the onboarding are saved and not asked again.
// - Autopilot: the choice is shown before sending, the user overrides it, and the request the
//   provider receives carries the overridden effort.
// - Vision: pasting an image with a text-only model proposes a catalog model that reads images;
//   after one click the image leaves with the message (as a data URL part) and is not stored.
// - Background: with « Continuer en arrière-plan » on, closing the window hides it and the running
//   mission goes on (checked through the API); quitting while it runs asks first.
//
// Mount points assumed (integrator): <ProfileOnboardingGate/> in App, `useImageAttachments` +
// `useAutopilot` passed to ChatView's Composer, the store forwarding `extras`, DesktopSection as
// the settings section « Bureau et affichage », and the desktop presence in main.
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { launchNova, makeUserDataDir, removeDir, type LaunchedNova } from "./fixtures";
import { connect, currentWorkspaceId, latestMission, missionEvents, planFromAgent, shot, stubFolderPicker, TERMINAL_EVENTS, writeShopProject } from "./j2a-kit";
import { startMockOpenRouter, type MissionScript, type MockOpenRouter } from "./mock-openrouter";

/** A 1×1 PNG. */
const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

/** A read-only mission that takes a few seconds (the window is closed meanwhile). */
const SLOW_READ: MissionScript = {
  plan: { summary: "Je lis le panier.", tasks: [{ title: "Lire le panier", acceptance: { kind: "manual", detail: "" } }] },
  step({ results }) {
    if (results.length === 0) return { kind: "tools", calls: [{ name: "read_file", args: { path: "src/cart.js" } }], delayMs: 3_000 };
    return { kind: "answer", text: "Le panier additionne les prix.", delayMs: 3_000 };
  },
};

let mock: MockOpenRouter;
let userDataDir: string;
let project: string;
let nova: LaunchedNova | null = null;

test.beforeEach(async () => {
  mock = await startMockOpenRouter({ scripts: { slow: SLOW_READ } });
  userDataDir = makeUserDataDir();
  project = makeUserDataDir();
  writeShopProject(project);
});

test.afterEach(async () => {
  if (nova) {
    // Quitting must never hang on the question in teardown: answer « Quitter quand même ».
    await nova.app.evaluate(({ dialog }) => {
      dialog.showMessageBox = (() => Promise.resolve({ response: 1, checkboxChecked: false })) as typeof dialog.showMessageBox;
    }).catch(() => {});
    await nova.app.close().catch(() => {});
  }
  nova = null;
  await mock.close();
  removeDir(userDataDir);
  removeDir(project);
});

async function settings(page: Page): Promise<{ onboarding: { profile: string | null }; display: { density: string }; desktop: { keepRunningOnClose: boolean } }> {
  return page.evaluate(async () => {
    const result = await window.novaBridge.settings.get();
    if (!result.ok) throw new Error(result.error.message);
    return result.value;
  });
}

async function updateSettings(page: Page, patch: Record<string, unknown>): Promise<void> {
  await page.evaluate(async (value) => {
    const result = await window.novaBridge.settings.update(value);
    if (!result.ok) throw new Error(result.error.message);
  }, patch);
}

/** Onboarding done and the autopilot on, then the UI reloads on that state. */
async function readyForChat(page: Page, chat: Record<string, boolean>): Promise<void> {
  await updateSettings(page, { onboarding: { profile: "code", completedAt: Date.now() }, chat });
  await page.reload();
}

function chatRequests(marker: string): { model: string; body: Record<string, unknown> }[] {
  return mock.requests
    .filter((request) => request.path === "/api/v1/chat/completions")
    .map((request) => request.body as Record<string, unknown>)
    .filter((body) => JSON.stringify(body.messages ?? []).includes(marker))
    .map((body) => ({ model: String(body.model), body }));
}

test("first run: the profile and density are saved and not asked again", async () => {
  nova = await launchNova({ userDataDir, mock });
  const { page } = nova;
  await connect(page, { firstRun: true });
  const dialog = page.getByRole("dialog", { name: "Comment vas-tu utiliser NOVA ?" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("radio", { name: /Documents et création/ }).check();
  // The profile proposes « Résultat »; the user prefers « Tout ».
  await expect(dialog.getByRole("radio", { name: /^Résultat/ })).toBeChecked();
  await dialog.getByRole("radio", { name: /^Tout/ }).check();
  await shot(page, "j2b-l7-01-onboarding");
  await dialog.getByRole("button", { name: "Commencer" }).click();
  await expect(dialog).toBeHidden();
  const saved = await settings(page);
  expect(saved.onboarding.profile).toBe("documents");
  expect(saved.display.density).toBe("all");
  await page.reload();
  await expect(page.getByRole("button", { name: "Nouvelle conversation" })).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Comment vas-tu utiliser NOVA ?" })).toHaveCount(0);
});

test("autopilot: the choice is shown before sending and the overridden effort reaches the provider", async () => {
  nova = await launchNova({ userDataDir, mock });
  const { page } = nova;
  await connect(page);
  await readyForChat(page, { autopilot: true });
  await page.getByRole("button", { name: "Nouvelle conversation" }).click();
  const composer = page.getByRole("textbox", { name: "Message" });
  await expect(page.getByText(/Pilote automatique : Entrée prépare les réglages/)).toBeVisible();
  await composer.fill("Compare deux architectures de panier [ap]");
  await composer.press("Enter");

  // The mock classifier answers with its two closed fields; the card says what NOVA proposes.
  const card = page.getByRole("region", { name: /Réglages (proposés pour ce message|par défaut)/ });
  await expect(card).toBeVisible();
  const classifier = chatRequests("[ap]").find(({ body }) => JSON.stringify(body.messages).includes("You classify one chat message"));
  expect(classifier?.model).toBe("deepseek/deepseek-v4-flash");
  expect(chatRequests("[ap]").filter(({ body }) => !JSON.stringify(body.messages).includes("You classify"))).toHaveLength(0);

  await card.getByRole("radio", { name: "Élevé" }).click();
  await shot(page, "j2b-l7-02-autopilot");
  await composer.press("Enter");
  await expect(page.getByText(/Réponse simulée/).first()).toBeVisible();
  const sent = chatRequests("[ap]").filter(({ body }) => !JSON.stringify(body.messages).includes("You classify"));
  expect(sent).toHaveLength(1);
  expect(sent[0]?.body.reasoning).toEqual({ effort: "high" });
});

test("pasted image: a vision model of the catalog is proposed, the image leaves once and is not stored", async () => {
  nova = await launchNova({ userDataDir, mock });
  const { page } = nova;
  await connect(page);
  await readyForChat(page, { autopilot: false });
  await page.getByRole("button", { name: "Nouvelle conversation" }).click();
  const composer = page.getByRole("textbox", { name: "Message" });
  await composer.fill("Que montre cette capture ? [img]");
  await composer.evaluate((element, base64) => {
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], "capture.png", { type: "image/png" }));
    element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }));
  }, PNG_BASE64);
  await expect(page.getByRole("img", { name: "capture.png" })).toBeVisible();
  await expect(page.getByText(/ne lit pas les images/)).toBeVisible();
  await composer.press("Enter");
  expect(chatRequests("[img]")).toHaveLength(0);
  await shot(page, "j2b-l7-03-vision-suggestion");

  await page.getByRole("button", { name: "Utiliser DeepSeek: DeepSeek V4.1 Flash" }).click();
  await expect(page.getByText(/ne lit pas les images/)).toHaveCount(0);
  await composer.press("Enter");
  await expect(page.getByText(/Réponse simulée/).first()).toBeVisible();
  const [request] = chatRequests("[img]");
  expect(request?.model).toBe("deepseek/deepseek-v4.1-flash");
  const messages = (request?.body.messages ?? []) as { role: string; content: unknown }[];
  const user = messages.findLast((message) => message.role === "user");
  expect(user?.content).toEqual([
    { type: "text", text: "Que montre cette capture ? [img]" },
    { type: "image_url", image_url: { url: `data:image/png;base64,${PNG_BASE64}` } },
  ]);
  await expect(page.getByRole("img", { name: "capture.png" })).toHaveCount(0);
  // Only the text is kept with the conversation.
  const stored = await page.evaluate(async () => {
    const list = await window.novaBridge.conversations.list({});
    if (!list.ok || !list.value.items[0]) throw new Error("no conversation");
    const detail = await window.novaBridge.conversations.get({ conversationId: list.value.items[0].id });
    if (!detail.ok) throw new Error(detail.error.message);
    return JSON.stringify(detail.value.messages);
  });
  expect(stored).toContain("Que montre cette capture ? [img]");
  expect(stored).not.toContain(PNG_BASE64);
});

test("background: closing the window keeps the mission running; quitting while it runs asks first", async () => {
  // As `launchOnFolder`, with the first-run question answered before the folder is opened.
  nova = await launchNova({ userDataDir, mock });
  const { page, app } = nova;
  await stubFolderPicker(nova, project);
  await connect(page);
  await updateSettings(page, { onboarding: { profile: "code", completedAt: Date.now() } });
  await page.reload();
  await page.getByRole("region", { name: "Ouvrir un dossier" }).getByRole("button", { name: "Ouvrir un dossier…" }).click();
  await expect(page.getByRole("treeitem", { name: /package\.json/ }).first()).toBeVisible();

  // The option is turned on where it is explained.
  await page.getByRole("button", { name: "Réglages" }).first().click();
  await page.getByRole("button", { name: "Bureau et affichage" }).click();
  await expect(page.getByText(/Nomi reste dans la barre système/)).toBeVisible();
  await page.getByRole("switch", { name: "Continuer en arrière-plan quand la fenêtre est fermée" }).click();
  await expect.poll(async () => (await settings(page)).desktop.keepRunningOnClose).toBe(true);
  await shot(page, "j2b-l7-04-background-option");

  const workspaceId = await currentWorkspaceId(page);
  await page.getByRole("navigation", { name: "Espaces" }).getByRole("button", { name: "Accueil" }).click();
  await page.getByRole("button", { name: "Confier une mission à Nomi" }).click();
  await planFromAgent(page, "Comprendre", "Explique le panier [script:slow]");
  await page.getByRole("button", { name: "Lancer la mission" }).click();
  await expect.poll(async () => (await latestMission(page, workspaceId)).state).toBe("running");

  // Close the window: it hides, NOVA keeps running, and the desktop state says why.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((window) => window.isVisible()))).toEqual([false]);
  const state = await page.evaluate(async () => {
    const result = await window.novaBridge.desktop.state();
    if (!result.ok) throw new Error(result.error.message);
    return result.value;
  });
  expect(state.keepRunningOnClose).toBe(true);
  expect(state.activity.runningMissions).toBe(1);

  // Quitting now asks, listing the mission; « Annuler » keeps NOVA and the mission running.
  await app.evaluate(({ dialog }) => {
    const asked: string[] = [];
    (globalThis as { novaQuitQuestions?: string[] }).novaQuitQuestions = asked;
    dialog.showMessageBox = ((...args: unknown[]) => {
      const options = args.at(-1) as { detail?: string };
      asked.push(options.detail ?? "");
      return Promise.resolve({ response: 0, checkboxChecked: false });
    }) as typeof dialog.showMessageBox;
  });
  await app.evaluate(({ app: electronApp }) => electronApp.quit());
  await expect.poll(() => app.evaluate(() => (globalThis as { novaQuitQuestions?: string[] }).novaQuitQuestions?.length ?? 0)).toBe(1);
  const question = await app.evaluate(() => (globalThis as { novaQuitQuestions?: string[] }).novaQuitQuestions?.[0] ?? "");
  expect(question).toContain("1 mission en cours");

  // The mission ends while the window is hidden (checked through the API).
  const missionId = (await latestMission(page, workspaceId)).id;
  await expect
    .poll(async () => (await missionEvents(page, missionId)).some((event) => TERMINAL_EVENTS.includes(event.type)), { timeout: 30_000 })
    .toBe(true);
  expect((await missionEvents(page, missionId)).map((event) => event.type)).toContain("mission.succeeded");
});

interface TrayItem {
  label?: string;
  enabled?: boolean;
  submenu?: TrayItem[];
}

/** Labels of the tray menu NOVA built last (Menu.buildFromTemplate is observed in main). */
async function trayLabels(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(() => {
    const templates = (globalThis as { novaTrayTemplates?: TrayItem[][] }).novaTrayTemplates ?? [];
    const flat = (items: TrayItem[]): string[] => items.flatMap((item) => [...(item.label ? [item.label] : []), ...flat(item.submenu ?? [])]);
    return flat(templates.at(-1) ?? []);
  });
}

/** Clicks the entry `label` of the last tray menu, as the OS would. */
async function clickTray(app: ElectronApplication, label: string): Promise<void> {
  await app.evaluate((_electron, wanted) => {
    const templates = (globalThis as { novaTrayTemplates?: { label?: string; submenu?: unknown[]; click?: () => void }[][] }).novaTrayTemplates ?? [];
    type Item = { label?: string; submenu?: unknown[]; click?: () => void };
    const find = (items: Item[]): Item | undefined =>
      items.map((item) => (item.label === wanted ? item : find((item.submenu ?? []) as Item[]))).find((item) => item !== undefined);
    const item = find(templates.at(-1) ?? []);
    if (!item?.click) throw new Error(`no tray entry ${wanted}`);
    item.click();
  }, label);
}

test("tray: Nomi's state and the running mission are in the menu; « Quitter NOVA » warns while it runs, not after", async () => {
  test.setTimeout(120_000);
  nova = await launchNova({ userDataDir, mock });
  const { page, app } = nova;
  // Every tray menu NOVA builds from now on is recorded (the OS menu itself is not scriptable).
  await app.evaluate(({ Menu }) => {
    const store = globalThis as { novaTrayTemplates?: unknown[] };
    store.novaTrayTemplates = [];
    const build = Menu.buildFromTemplate.bind(Menu);
    // Electron builds submenus through the same function: only the outermost call is the tray menu.
    let depth = 0;
    Menu.buildFromTemplate = ((template: Parameters<typeof Menu.buildFromTemplate>[0]) => {
      if (depth === 0) store.novaTrayTemplates?.push(template);
      depth += 1;
      try {
        return build(template);
      } finally {
        depth -= 1;
      }
    }) as typeof Menu.buildFromTemplate;
  });
  await stubFolderPicker(nova, project);
  await connect(page);
  await updateSettings(page, { desktop: { keepRunningOnClose: true } });
  await page.reload();
  await page.getByRole("region", { name: "Ouvrir un dossier" }).getByRole("button", { name: "Ouvrir un dossier…" }).click();
  await expect(page.getByRole("treeitem", { name: /package\.json/ }).first()).toBeVisible();
  const desktopState = await page.evaluate(async () => {
    const result = await window.novaBridge.desktop.state();
    if (!result.ok) throw new Error(result.error.message);
    return result.value;
  });
  expect(desktopState.trayAvailable).toBe(true);

  const workspaceId = await currentWorkspaceId(page);
  await page.getByRole("navigation", { name: "Espaces" }).getByRole("button", { name: "Accueil" }).click();
  await page.getByRole("button", { name: "Confier une mission à Nomi" }).click();
  await planFromAgent(page, "Comprendre", "Explique le panier au plateau [script:slow]");
  await page.getByRole("button", { name: "Lancer la mission" }).click();

  // The menu says what Nomi does and lists the mission.
  await expect.poll(() => trayLabels(app), { timeout: 20_000 }).toEqual(
    expect.arrayContaining(["Nomi travaille : 1 mission en cours", "Ouvrir NOVA", "Missions en cours (1)", "Explique le panier au plateau [script:slow]", "Quitter NOVA"]),
  );

  // Window closed (hidden); « Ouvrir NOVA » brings it back.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((window) => window.isVisible()))).toEqual([false]);
  await clickTray(app, "Ouvrir NOVA");
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((window) => window.isVisible()))).toEqual([true]);

  // « Quitter NOVA » while the mission runs: the question names it; « Annuler » keeps everything.
  await app.evaluate(({ dialog }) => {
    const asked: string[] = [];
    (globalThis as { novaQuitQuestions?: string[] }).novaQuitQuestions = asked;
    dialog.showMessageBox = ((...args: unknown[]) => {
      const options = args.at(-1) as { detail?: string };
      asked.push(options.detail ?? "");
      return Promise.resolve({ response: 0, checkboxChecked: false });
    }) as typeof dialog.showMessageBox;
  });
  await clickTray(app, "Quitter NOVA");
  await expect.poll(() => app.evaluate(() => (globalThis as { novaQuitQuestions?: string[] }).novaQuitQuestions?.length ?? 0)).toBe(1);
  const question = await app.evaluate(() => (globalThis as { novaQuitQuestions?: string[] }).novaQuitQuestions?.[0] ?? "");
  expect(question).toContain("1 mission en cours : « Explique le panier au plateau [script:slow] »");
  await shot(page, "j2b-l7-05-tray-quit-cancelled");

  // The mission ends; the menu goes back to rest, and quitting no longer asks.
  const missionId = (await latestMission(page, workspaceId)).id;
  await expect.poll(async () => (await missionEvents(page, missionId)).some((event) => TERMINAL_EVENTS.includes(event.type)), { timeout: 30_000 }).toBe(true);
  await expect.poll(() => trayLabels(app), { timeout: 20_000 }).toEqual(expect.arrayContaining(["Nomi : au repos", "Aucune mission en cours"]));
  const closed = new Promise<void>((resolve) => app.once("close", () => resolve()));
  await clickTray(app, "Quitter NOVA");
  await closed;
  nova = null;
});
