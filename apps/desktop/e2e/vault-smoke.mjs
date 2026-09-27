// Launches the built app WITHOUT Playwright (whose loader forces --password-store=basic) and checks
// the vault level NOVA detects on this machine. Usage (from apps/desktop, after electron-vite build):
//   node e2e/vault-smoke.mjs --expect os|weak|unavailable
// On Linux, "os" needs a Secret Service: dbus-run-session -- bash e2e/run-with-keyring.sh node e2e/vault-smoke.mjs --expect os
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const expected = process.argv[process.argv.indexOf("--expect") + 1];
if (!["os", "weak", "unavailable"].includes(expected)) {
  console.error("usage: node e2e/vault-smoke.mjs --expect os|weak|unavailable");
  process.exit(2);
}

const appDir = fileURLToPath(new URL("..", import.meta.url));
const electronPath = createRequire(import.meta.url)("electron");
const userDataDir = mkdtempSync(join(tmpdir(), "nova-vault-smoke-"));
const logFile = join(userDataDir, "logs", "nova.log");
const args = [appDir, ...(process.platform === "linux" ? ["--no-sandbox"] : [])];
const child = spawn(electronPath, args, {
  env: { ...process.env, NOVA_USER_DATA_DIR: userDataDir },
  stdio: "ignore",
});

function detectedVault() {
  if (!existsSync(logFile)) return null;
  for (const line of readFileSync(logFile, "utf8").split("\n")) {
    if (!line.includes('"vault detected"')) continue;
    return JSON.parse(line).data;
  }
  return null;
}

let vault = null;
for (let waited = 0; waited < 30_000 && vault === null; waited += 250) {
  await new Promise((resolve) => setTimeout(resolve, 250));
  vault = detectedVault();
}
// A vault call blocked on an OS prompt can ignore SIGTERM: escalate so the check always ends.
const exited = new Promise((resolve) => child.once("exit", resolve));
child.kill();
const forced = setTimeout(() => child.kill("SIGKILL"), 5_000);
await exited;
clearTimeout(forced);

if (vault === null) {
  console.error("[vault-smoke] FAILED: no 'vault detected' log line within 30 s");
  console.error(existsSync(logFile) ? readFileSync(logFile, "utf8").slice(-4000) : "[vault-smoke] no log file was written");
  process.exit(1);
}
rmSync(userDataDir, { recursive: true, force: true });
const ok = vault.level === expected;
process.stdout.write(`[vault-smoke] detected level=${vault.level} backend=${vault.backend} expected=${expected}\n`);
if (!ok) console.error(`[vault-smoke] FAILED (exit 1)`);
process.exit(ok ? 0 : 1);
