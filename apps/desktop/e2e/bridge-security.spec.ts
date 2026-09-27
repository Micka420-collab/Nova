// Security and runtime invariants exercised through the real app (built out/), at the bridge level.
import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import type { ChatStreamEvent, ConversationDetail, IpcResult, NovaBridge } from "@nova/shared";
import { launchNova, makeUserDataDir, readTreeAsText, removeDir, type LaunchedNova } from "./fixtures";
import { MOCK_KEYS, startMockOpenRouter, type MockOpenRouter } from "./mock-openrouter";

declare global {
  interface Window {
    novaBridge: NovaBridge;
  }
}

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

/** Picks the storage the vault of this machine allows without extra consent. */
async function saveValidKey(page: LaunchedNova["page"]): Promise<string> {
  return page.evaluate(async (apiKey) => {
    const info = await window.novaBridge.app.info();
    if (!info.ok) throw new Error(info.error.message);
    const storage = info.value.vault.level === "os" ? "vault" : "session";
    const saved = await window.novaBridge.connection.setKey({ providerId: "openrouter", apiKey, storage });
    if (!saved.ok) throw new Error(saved.error.message);
    return saved.value.state;
  }, MOCK_KEYS.valid);
}

/** Sends a message and resolves with the terminal event of its stream. */
async function sendAndSettle(page: LaunchedNova["page"], content: string, modelId: string) {
  return page.evaluate(
    (request) =>
      new Promise<{ result: IpcResult<unknown>; terminal: ChatStreamEvent | null }>((resolve) => {
        let streamId: string | null = null;
        const early: ChatStreamEvent[] = [];
        const unsubscribe = window.novaBridge.chat.onEvent((event) => {
          if (streamId === null) return void early.push(event);
          if (event.streamId === streamId && ["completed", "stopped", "failed"].includes(event.type)) {
            unsubscribe();
            resolve({ result: { ok: true, value: null }, terminal: event });
          }
        });
        void window.novaBridge.chat.send({ conversationId: null, ...request }).then((result) => {
          if (!result.ok) {
            unsubscribe();
            return resolve({ result, terminal: null });
          }
          streamId = result.value.streamId;
          const done = early.find(
            (event) => event.streamId === streamId && ["completed", "stopped", "failed"].includes(event.type),
          );
          if (done) {
            unsubscribe();
            resolve({ result, terminal: done });
          }
        });
      }),
    { content, modelId },
  );
}

test("the renderer has no Node access and only the fixed bridge", async () => {
  nova = await launchNova({ userDataDir, mock });
  const surface = await nova.page.evaluate(() => ({
    require: typeof (window as unknown as { require?: unknown }).require,
    process: typeof (window as unknown as { process?: unknown }).process,
    bridgeGroups: Object.keys(window.novaBridge).sort(),
    url: window.location.href,
  }));
  expect(surface.require).toBe("undefined");
  expect(surface.process).toBe("undefined");
  expect(surface.bridgeGroups).toEqual([
    "app",
    "approvals",
    "chat",
    "checkpoints",
    "companion",
    "connection",
    "conversations",
    "files",
    "git",
    "mcp",
    "missions",
    "models",
    "permissions",
    "search",
    "settings",
    "terminal",
    "web",
    "workspace",
  ]);
  expect(surface.url).toBe("nova://app/index.html");
});

test("CSP blocks inline scripts and any network egress from the renderer", async () => {
  nova = await launchNova({ userDataDir, mock });
  const outcome = await nova.page.evaluate(async (mockUrl) => {
    const script = document.createElement("script");
    script.textContent = "document.body.dataset.inlineRan = 'yes'";
    document.body.append(script);
    const tryFetch = (url: string) =>
      fetch(url).then(
        () => "reached",
        () => "blocked",
      );
    return {
      inlineRan: document.body.dataset.inlineRan === "yes",
      internet: await tryFetch("https://openrouter.ai/api/v1/models"),
      loopback: await tryFetch(`${mockUrl}/models`),
    };
  }, mock.baseUrl);
  expect(outcome).toEqual({ inlineRan: false, internet: "blocked", loopback: "blocked" });
});

test("navigation away and new windows are refused; external links are allowlisted", async () => {
  nova = await launchNova({ userDataDir, mock });
  const { page, app } = nova;
  const opened = await page.evaluate(() => window.open("https://example.com") === null);
  expect(opened).toBe(true);
  await page.evaluate(() => {
    window.location.href = "https://example.com/";
  });
  await page.waitForTimeout(500);
  expect(page.url()).toBe("nova://app/index.html");
  expect(app.windows()).toHaveLength(1);
  const refused = await page.evaluate(async () => [
    await window.novaBridge.app.openExternal({ url: "https://example.com/phish" }),
    await window.novaBridge.app.openExternal({ url: "http://openrouter.ai/keys" }),
  ]);
  for (const result of refused) {
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid_request");
  }
});

test("the vault level reflects the machine and is never overstated", async () => {
  nova = await launchNova({ userDataDir, mock });
  const info = await nova.page.evaluate(async () => {
    const result = await window.novaBridge.app.info();
    if (!result.ok) throw new Error(result.error.message);
    return result.value;
  });
  // Playwright's Electron loader forces --password-store=basic, so under Playwright a Linux run
  // never reaches the keyring: the app must then report a weak/unavailable vault, not "os".
  // The real keyring path is proven outside Playwright by e2e/vault-smoke.mjs.
  if (process.platform === "linux") expect(["weak", "unavailable"]).toContain(info.vault.level);
  else expect(info.vault.level).toBe("os");
});

test("an invalid key is refused and nothing is stored", async () => {
  nova = await launchNova({ userDataDir, mock });
  const outcome = await nova.page.evaluate(async (apiKey) => {
    const saved = await window.novaBridge.connection.setKey({ providerId: "openrouter", apiKey, storage: "session" });
    const view = await window.novaBridge.connection.get({ providerId: "openrouter" });
    return { saved, view };
  }, MOCK_KEYS.invalid);
  expect(outcome.saved.ok).toBe(false);
  if (!outcome.saved.ok) {
    expect(outcome.saved.error.code).toBe("provider");
    expect(outcome.saved.error.providerError?.code).toBe("invalid_key");
    expect(JSON.stringify(outcome.saved)).not.toContain(MOCK_KEYS.invalid);
  }
  expect(outcome.view.ok && outcome.view.value.state).toBe("absent");
});

test("a real streamed reply is persisted with usage; the key and contents never reach disk logs", async () => {
  nova = await launchNova({ userDataDir, mock });
  expect(await saveValidKey(nova.page)).toBe("valid");
  const { result, terminal } = await sendAndSettle(nova.page, "Bonjour Nomi, test de persistance", "deepseek/deepseek-v4-flash");
  expect(result.ok).toBe(true);
  expect(terminal?.type).toBe("completed");
  if (terminal?.type !== "completed") return;
  expect(terminal.message.content).toContain("Réponse simulée");
  expect(terminal.message.usage?.cost).toBeCloseTo(0.0000123, 10);
  expect(terminal.message.servedProvider).toBe("MockProvider");

  const chatRequest = mock.requests.find((request) => request.path === "/api/v1/chat/completions");
  expect(chatRequest?.body).toMatchObject({ stream: true, provider: { data_collection: "deny" } });

  await nova.app.close();
  nova = null;
  const onDisk = readTreeAsText(userDataDir);
  expect(onDisk).not.toContain(MOCK_KEYS.valid);
  expect(onDisk).not.toContain(MOCK_KEYS.valid.slice(10, 40));
  const logs = readTreeAsText(`${userDataDir}/logs`);
  expect(logs).not.toContain("Bonjour Nomi");
  expect(logs).not.toContain("Réponse simulée");

  nova = await launchNova({ userDataDir, mock });
  const detail = await nova.page.evaluate(async (conversationId) => {
    const loaded = await window.novaBridge.conversations.get({ conversationId });
    if (!loaded.ok) throw new Error(loaded.error.message);
    return loaded.value;
  }, terminal.conversationId);
  expect(detail.messages.map((message) => message.status)).toEqual(["complete", "complete"]);
  expect(detail.usage.cost).toBeGreaterThan(0);
});

test("a crash during generation leaves an interrupted message, never a phantom stream", async () => {
  nova = await launchNova({ userDataDir, mock });
  await saveValidKey(nova.page);
  const started = await nova.page.evaluate(async () => {
    const result = await window.novaBridge.chat.send({
      conversationId: null,
      content: "[slow] longue réponse",
      modelId: "deepseek/deepseek-v4-flash",
    });
    if (!result.ok) throw new Error(result.error.message);
    return result.value;
  });
  await expect
    .poll(() => mock.requests.filter((request) => request.path === "/api/v1/chat/completions").length)
    .toBe(1);
  await nova.page.waitForTimeout(1200);
  // A real crash takes the whole process tree down; on Windows killing only the main process
  // leaves Chromium helpers holding the single-instance lock for a while.
  const crashed = nova.app.process();
  const exited = new Promise((resolve) => crashed.once("exit", resolve));
  if (process.platform === "win32" && crashed.pid) execFileSync("taskkill", ["/pid", String(crashed.pid), "/T", "/F"]);
  else crashed.kill("SIGKILL");
  await exited;
  nova = null;

  nova = await launchNova({ userDataDir, mock });
  const detail = await nova.page.evaluate(async (conversationId) => {
    const loaded = await window.novaBridge.conversations.get({ conversationId });
    if (!loaded.ok) throw new Error(loaded.error.message);
    const active = await window.novaBridge.chat.active();
    return { detail: loaded.value, active: active.ok ? active.value : null };
  }, started.conversation.id);
  const assistant = (detail.detail as ConversationDetail).messages.at(-1);
  expect(assistant?.status).toBe("interrupted");
  expect(assistant?.content.length).toBeGreaterThan(0);
  expect(detail.active).toEqual([]);
});
