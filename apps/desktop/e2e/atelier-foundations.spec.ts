// J2-A foundations exercised on the built app (out/): utilityProcess workers with the native
// dependencies (node-pty, ripgrep), the per-load style nonce of the CSP, and the MessagePort relay
// main → preload → page.
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { expect, test } from "@playwright/test";
import { appDir, launchNova, makeUserDataDir, removeDir, type LaunchedNova } from "./fixtures";
import { startMockOpenRouter, type MockOpenRouter } from "./mock-openrouter";

const electronBinary = createRequire(import.meta.url)("electron") as string;

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

test("every worker answers ping; node-pty and ripgrep run inside them", () => {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) if (value !== undefined) env[name] = value;
  env["NOVA_USER_DATA_DIR"] = userDataDir;
  const sandboxArgs = process.platform === "linux" ? ["--no-sandbox"] : [];
  const stdout = execFileSync(electronBinary, [appDir, ...sandboxArgs, "--nova-selftest=workers"], {
    env,
    timeout: 60_000,
    encoding: "utf8",
  });
  const line = stdout.split("\n").find((candidate) => candidate.startsWith('{"novaSelfTest"'));
  expect(line).toBeDefined();
  const report = JSON.parse(line ?? "{}").novaSelfTest;
  expect(report.ok).toBe(true);
  for (const name of ["pty-host", "fs-worker", "agent-runtime", "mcp-host"]) {
    expect(report.workers[name]).toMatchObject({ ok: true, error: null });
  }
  expect(report.pty.output).toContain("nova-pty-ok");
  expect(report.ripgrep.version).toMatch(/^ripgrep \d+\.\d+\.\d+/);
  expect(report.chain).toEqual({ ok: true, detail: "chain-host ok" });
});

test("styles need this load's nonce; inline styles without it are blocked", async () => {
  nova = await launchNova({ userDataDir, mock });
  const result = await nova.page.evaluate(() => {
    const nonce = document.querySelector<HTMLMetaElement>('meta[name="nova-style-nonce"]')?.content ?? null;
    const probe = (id: string, withNonce: boolean): string => {
      const target = document.createElement("div");
      target.id = id;
      document.body.append(target);
      const style = document.createElement("style");
      if (withNonce && nonce) style.nonce = nonce;
      style.textContent = `#${id} { color: rgb(1, 2, 3); }`;
      document.head.append(style);
      const color = getComputedStyle(target).color;
      style.remove();
      target.remove();
      return color;
    };
    return { nonce, withNonce: probe("probe-with-nonce", true), withoutNonce: probe("probe-without-nonce", false) };
  });
  expect(result.nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
  expect(result.withNonce).toBe("rgb(1, 2, 3)");
  expect(result.withoutNonce).not.toBe("rgb(1, 2, 3)");

  // A reload gets a new nonce.
  await nova.page.reload();
  const next = await nova.page.evaluate(
    () => document.querySelector<HTMLMetaElement>('meta[name="nova-style-nonce"]')?.content ?? null,
  );
  expect(next).not.toBe(result.nonce);
});

test("a MessagePort posted by main reaches the page through the preload relay", async () => {
  nova = await launchNova({ userDataDir, mock });
  await nova.page.evaluate(() => {
    window.addEventListener("message", (event) => {
      const data = event.data as { type?: string; kind?: string; id?: string };
      const port = event.ports[0];
      if (data?.type !== "nova:port" || !port) return;
      port.onmessage = (reply) => {
        (window as { novaPortResult?: unknown }).novaPortResult = { envelope: data, reply: reply.data };
      };
      port.postMessage("ping");
    });
  });
  await nova.app.evaluate(({ BrowserWindow, MessageChannelMain }) => {
    const { port1, port2 } = new MessageChannelMain();
    port1.on("message", (event) => port1.postMessage(`echo:${String(event.data)}`));
    port1.start();
    (globalThis as { novaTestPort?: unknown }).novaTestPort = port1;
    BrowserWindow.getAllWindows()[0]?.webContents.postMessage(
      "nova:port:transfer",
      { kind: "terminal", id: "00000000-0000-4000-8000-000000000001" },
      [port2],
    );
  });
  const result = await nova.page.waitForFunction(() => (window as { novaPortResult?: unknown }).novaPortResult);
  expect(await result.jsonValue()).toEqual({
    envelope: { type: "nova:port", kind: "terminal", id: "00000000-0000-4000-8000-000000000001" },
    reply: "echo:ping",
  });
});
