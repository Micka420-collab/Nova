// node-pty 1.1.0 publishes its macOS `spawn-helper` binaries without the executable bit, so every
// terminal fails on macOS with "posix_spawnp failed" (dev, E2E and the packaged app, which copies
// the file mode from node_modules). Run as the root `postinstall`: gives each spawn-helper of the
// installed node-pty its executable bits. The file is replaced by an executable copy rather than
// chmod'ed in place: pnpm hard-links node_modules to its content-addressed store.
import { chmodSync, copyFileSync, existsSync, readdirSync, renameSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Every spawn-helper of a node-pty package: prebuilds/<platform-arch>/ and a source build. */
export function spawnHelperPaths(packageDir) {
  const prebuilds = join(packageDir, "prebuilds");
  const dirs = existsSync(prebuilds) ? readdirSync(prebuilds).map((name) => join(prebuilds, name)) : [];
  return [...dirs, join(packageDir, "build", "Release")].map((dir) => join(dir, "spawn-helper")).filter((path) => existsSync(path));
}

/** Makes every spawn-helper executable; returns the ones that were not. */
export function fixSpawnHelperModes(packageDir) {
  const fixed = [];
  for (const path of spawnHelperPaths(packageDir)) {
    const mode = statSync(path).mode & 0o777;
    if ((mode & 0o111) === 0o111) continue;
    const temp = `${path}.nova-mode`;
    copyFileSync(path, temp);
    chmodSync(temp, mode | 0o755);
    renameSync(temp, path);
    fixed.push(path);
  }
  return fixed;
}

function nodePtyDir() {
  const desktop = fileURLToPath(new URL("../apps/desktop/package.json", import.meta.url));
  try {
    return dirname(createRequire(desktop).resolve("node-pty/package.json"));
  } catch {
    return null;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.platform !== "win32") {
  const dir = nodePtyDir();
  // A filtered install without apps/desktop has no node-pty: nothing to fix.
  for (const path of dir ? fixSpawnHelperModes(dir) : []) process.stdout.write(`[node-pty-modes] made executable: ${path}\n`);
}
