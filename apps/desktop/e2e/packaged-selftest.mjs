// Runs `--nova-selftest=workers` against the PACKAGED app in release/ (fuses on, asar, unpacked
// native deps) rather than the out/ build: proves node-pty and ripgrep ship for the arch that was
// packed. Usage (from apps/desktop, after electron-builder): node e2e/packaged-selftest.mjs
// On Linux, run it under a display: xvfb-run -a node e2e/packaged-selftest.mjs
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const releaseDir = fileURLToPath(new URL("../release", import.meta.url));

// electron-builder's unpacked output: mac/ (x64) or mac-arm64/, win-unpacked/, linux-unpacked/.
function packagedExecutables() {
  const dirs = existsSync(releaseDir) ? readdirSync(releaseDir) : [];
  if (process.platform === "darwin") {
    return dirs.filter((dir) => /^mac(-|$)/.test(dir)).map((dir) => join(releaseDir, dir, "NOVA.app", "Contents", "MacOS", "NOVA"));
  }
  if (process.platform === "win32") return [join(releaseDir, "win-unpacked", "NOVA.exe")];
  return [join(releaseDir, "linux-unpacked", "nova")];
}

const executables = packagedExecutables().filter((path) => existsSync(path));
if (executables.length === 0) {
  console.error(`[packaged-selftest] no packaged app found under ${releaseDir}`);
  console.error("[packaged-selftest] FAILED (exit 1)");
  process.exit(1);
}

let failed = false;
for (const executable of executables) {
  const args = [...(process.platform === "linux" ? ["--no-sandbox"] : []), "--nova-selftest=workers"];
  let stdout = "";
  try {
    // A packaged build ignores NOVA_USER_DATA_DIR; the self-test only writes logs/selftest.log.
    stdout = execFileSync(executable, args, { timeout: 60_000, encoding: "utf8" });
  } catch (error) {
    stdout = typeof error?.stdout === "string" ? error.stdout : "";
  }
  const line = stdout.split("\n").find((candidate) => candidate.startsWith('{"novaSelfTest"'));
  const report = line ? JSON.parse(line).novaSelfTest : null;
  process.stdout.write(`[packaged-selftest] ${executable}: ${line ?? "no report line"}\n`);
  if (report?.ok !== true) failed = true;
}

if (failed) console.error("[packaged-selftest] FAILED (exit 1)");
process.exit(failed ? 1 : 0);
