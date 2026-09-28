// User journeys through the real UI (acceptance scenarios 1, 2, 3, 14, 15, 16 — J1 scope).
import { join } from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import type { NovaBridge } from "@nova/shared";
import { artifactsDir, launchNova, makeUserDataDir, readTreeAsText, removeDir, type LaunchedNova } from "./fixtures";
import { MOCK_KEYS, startMockOpenRouter, type MockOpenRouter } from "./mock-openrouter";

declare global {
  interface Window {
    novaBridge: NovaBridge;
  }
}

const MODEL_ID = "deepseek/deepseek-v4-flash";
let mock: MockOpenRouter;
let userDataDir: string;
let nova: LaunchedNova | null = null;

test.beforeEach(async () => {
  mock = await startMockOpenRouter();
  userDataDir = makeUserDataDir();
});

test.afterEach(async () => {
  await nova?.app.close().catch(() => {});
  nova = null;
  await mock.close();
  removeDir(userDataDir);
});

/** axe-core audit. Legacy mode runs in the page itself: Electron cannot open the extra page axe uses. */
function audit(page: Page) {
  return new AxeBuilder({ page }).setLegacyMode(true).analyze();
}

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: join(artifactsDir, "screens", `${name}.png`) });
}

/** Fast setup through the bridge (key + default model), then reload the UI on that state. */
async function connectThroughBridge(page: Page, apiKey: string = MOCK_KEYS.valid): Promise<void> {
  await page.evaluate(
    async ({ key, modelId }) => {
      const saved = await window.novaBridge.connection.setKey({ providerId: "openrouter", apiKey: key, storage: "session" });
      if (!saved.ok) throw new Error(saved.error.message);
      // The first-run profile question is answered too (scenario 1 covers it through the UI).
      const settings = await window.novaBridge.settings.update({
        defaultModelId: modelId,
        onboarding: { profile: "code", completedAt: Date.now() },
        display: { density: "all" },
      });
      if (!settings.ok) throw new Error(settings.error.message);
    },
    { key: apiKey, modelId: MODEL_ID },
  );
  await page.reload();
}

/** Starts a new conversation from the chat composer and sends `text`. */
async function sendInNewChat(page: Page, text: string): Promise<void> {
  await page.getByRole("button", { name: "Nouvelle conversation" }).click();
  const composer = page.getByRole("textbox", { name: "Message" });
  await composer.fill(text);
  await composer.press("Enter");
}

test("scenario 1 — first run: key, model, streamed answer, restart keeps history", async () => {
  nova = await launchNova({ userDataDir, mock });
  const { page } = nova;
  await expect(page.getByRole("heading", { name: "Connecte OpenRouter pour commencer" })).toBeVisible();
  await shot(page, "01-onboarding");

  await page.getByLabel("Clé API OpenRouter").fill(MOCK_KEYS.valid);
  // Playwright forces a weak (basic) vault on Linux: explicit consent is required to persist.
  const info = await page.evaluate(() => window.novaBridge.app.info());
  const level = info.ok ? info.value.vault.level : "unavailable";
  if (level === "weak") {
    await page.getByRole("radio", { name: "Enregistrer avec une protection faible" }).check();
    await page.getByRole("checkbox", { name: /Je comprends/ }).check();
  } else if (level === "os") {
    await page.getByRole("radio", { name: "Coffre du système (recommandé)" }).check();
  }
  await page.getByRole("button", { name: "Tester et enregistrer" }).click();
  await expect(page.getByText("Clé vérifiée").first()).toBeVisible();
  await shot(page, "02-key-verified");

  await expect(page.getByRole("heading", { name: "Choisis un modèle" })).toBeVisible();
  await page.locator(".nova-model", { hasText: MODEL_ID }).first().click();
  await shot(page, "03-model-chosen");

  // J2-B: then one question on how NOVA will be used (display only), answered once.
  const profile = page.getByRole("dialog", { name: "Comment vas-tu utiliser NOVA ?" });
  await expect(profile).toBeVisible();
  await profile.getByRole("radio", { name: /Code et développement/ }).check();
  await profile.getByRole("button", { name: "Commencer" }).click();
  await expect(profile).toHaveCount(0);

  const composer = page.getByRole("textbox", { name: /Décris ton idée|Message/ }).first();
  await composer.fill("Bonjour Nomi, aide-moi à construire mon idée");
  await composer.press("Enter");
  await expect(page.getByText("Réponse simulée n°1")).toBeVisible();
  await expect(page.getByText(/constaté/).first()).toBeVisible();
  // A long title and a code block must not push the chat column past its panel.
  const overflow = await page.evaluate(() => {
    const chat = document.querySelector(".nova-chat");
    const box = document.querySelector(".nova-composer");
    if (!chat || !box) return null;
    return {
      scroll: chat.scrollWidth - chat.clientWidth,
      composerRight: box.getBoundingClientRect().right,
      chatRight: chat.getBoundingClientRect().right,
    };
  });
  expect(overflow?.scroll).toBe(0);
  expect(overflow?.composerRight).toBeLessThanOrEqual(overflow?.chatRight ?? 0);
  await shot(page, "04-first-answer");

  expect(await page.content()).not.toContain(MOCK_KEYS.valid);
  const storage = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
  expect(storage).not.toContain(MOCK_KEYS.valid);

  await nova.app.close();
  nova = null;
  expect(readTreeAsText(userDataDir)).not.toContain(MOCK_KEYS.valid);

  nova = await launchNova({ userDataDir, mock });
  const reopened = nova.page;
  await expect(reopened.getByRole("navigation", { name: "Navigation principale" })).toBeVisible();
  await reopened.getByText("Bonjour Nomi, aide-moi à construire mon idée").first().click();
  await expect(reopened.getByText("Réponse simulée n°1")).toBeVisible();
  await expect(reopened.getByRole("heading", { name: "Connecte OpenRouter pour commencer" })).toHaveCount(
    level === "unavailable" ? 1 : 0,
  );
  await shot(reopened, "05-after-restart");
});

test("scenario 2 — provider errors are explained, partial text kept, never silent", async () => {
  nova = await launchNova({ userDataDir, mock });
  const { page } = nova;
  await connectThroughBridge(page);

  await sendInNewChat(page, "[429] test du débit");
  await expect(page.getByText(/Trop de requêtes/).first()).toBeVisible();
  await expect(page.getByRole("button", { name: /Réessayer dans \d+ s/ })).toBeDisabled();
  await shot(page, "10-rate-limited");

  await sendInNewChat(page, "[midstream-error] coupure fournisseur");
  await expect(page.getByText("Erreur du fournisseur").first()).toBeVisible();
  await expect(page.getByText("Début de réponse")).toBeVisible();
  await shot(page, "11-midstream-error");

  await sendInNewChat(page, "[cut] connexion coupée");
  await expect(page.getByText("La réponse a été coupée en route").first()).toBeVisible();
  await expect(page.getByText("Réponse coupée")).toBeVisible();

  await sendInNewChat(page, "[502] modèle en panne");
  await expect(page.getByText("Modèle indisponible").first()).toBeVisible();
  await page.getByRole("button", { name: "Réessayer" }).first().click();
  await expect(page.getByText("Modèle indisponible").first()).toBeVisible();
});

test("scenario 2 — invalid key and exhausted credits", async () => {
  nova = await launchNova({ userDataDir, mock });
  const { page } = nova;
  await page.getByLabel("Clé API OpenRouter").fill(MOCK_KEYS.invalid);
  await page.getByRole("button", { name: "Tester et enregistrer" }).click();
  await expect(page.getByText("La clé OpenRouter est refusée").first()).toBeVisible();
  await shot(page, "12-invalid-key");

  await connectThroughBridge(page, MOCK_KEYS.noCredit);
  await sendInNewChat(page, "Bonjour");
  await expect(page.getByText("Crédits OpenRouter insuffisants").first()).toBeVisible();
  await shot(page, "13-no-credits");
});

test("scenario 3 — stop keeps the partial answer, frees the UI, and cancels the request", async () => {
  nova = await launchNova({ userDataDir, mock });
  const { page } = nova;
  await connectThroughBridge(page);

  await sendInNewChat(page, "[slow] écris longtemps");
  await expect(page.getByText(/mot3 /)).toBeVisible();
  await shot(page, "20-streaming");
  await page.getByRole("button", { name: "Arrêter" }).click();
  await expect(page.getByText("Génération arrêtée").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Arrêter" })).toHaveCount(0);
  await expect.poll(() => mock.requests.some((request) => request.aborted)).toBe(true);
  // A stopped generation may have been billed: its cost is unknown, never "0 constaté".
  // J2-A: the right-hand "Contexte" is a document of the workbench (VISUAL.md §1), no longer its own landmark.
  const context = page.getByRole("complementary", { name: "Plan de travail" }).getByRole("tabpanel", { name: "Contexte" });
  await expect(context.getByText(/coût inconnu|sans coût connu/)).toBeVisible();
  await shot(page, "21-stopped");

  const words = await page.getByText(/mot\d+/).first().textContent();
  await page.waitForTimeout(800);
  expect(await page.getByText(/mot\d+/).first().textContent()).toBe(words);

  await page.getByRole("button", { name: "Relancer" }).click();
  await expect(page.getByRole("button", { name: "Arrêter" })).toBeVisible();
  await page.getByRole("textbox", { name: "Message" }).press("Escape");
  await expect(page.getByText("Génération arrêtée").first()).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Message" })).toBeEnabled();
});

test("scenario 14 — companion hidden and reduced motion lose no function", async () => {
  nova = await launchNova({ userDataDir, mock });
  const { page } = nova;
  await page.evaluate(() => window.novaBridge.settings.update({ companion: { visible: false, motion: "reduce" } }));
  await connectThroughBridge(page);
  await expect(page.locator("html")).toHaveAttribute("data-motion", "reduce");
  await expect(page.locator(".nv-nomi")).toHaveCount(0);

  await sendInNewChat(page, "Bonjour sans compagnon");
  await expect(page.getByText(/Réponse simulée/)).toBeVisible();
  const running = await page.evaluate(
    () => document.getAnimations().filter((animation) => animation.playState === "running").length,
  );
  expect(running).toBe(0);
  await shot(page, "30-companion-hidden");
});

test("scenario 15 — keyboard navigation and automated accessibility audit", async () => {
  nova = await launchNova({ userDataDir, mock });
  const { page } = nova;
  const onboardingAudit = await audit(page);
  const serious = (report: typeof onboardingAudit) =>
    report.violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical");
  expect(serious(onboardingAudit).map((violation) => violation.id)).toEqual([]);

  await connectThroughBridge(page);
  await sendInNewChat(page, "Bonjour, test clavier");
  await expect(page.getByText(/Réponse simulée/)).toBeVisible();
  const chatAudit = await audit(page);
  expect(serious(chatAudit).map((violation) => violation.id)).toEqual([]);

  await page.keyboard.press("Control+k");
  await expect(page.getByRole("dialog", { name: /Palette de commandes/ })).toBeVisible();
  await page.keyboard.type("Réglages");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Réglages", level: 1 })).toBeVisible();
  await shot(page, "40-settings");

  await page.keyboard.press("Control+n");
  const composer = page.getByRole("textbox", { name: "Message" });
  await expect(composer).toBeFocused();
  // The ring is drawn by the composer container (focus-within), not by the bare textarea.
  const ring = await composer.evaluate((element) => {
    const box = element.closest(".nova-composer");
    return box ? getComputedStyle(box).boxShadow : "none";
  });
  const focusVisible = ring !== "none";
  expect(focusVisible).toBe(true);
});
