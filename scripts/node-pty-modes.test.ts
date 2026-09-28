import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fixSpawnHelperModes } from "./node-pty-modes.mjs";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nova-pty-modes-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function helper(relative: string, mode: number): string {
  const path = join(dir, relative, "spawn-helper");
  mkdirSync(join(dir, relative), { recursive: true });
  writeFileSync(path, "binary", { mode });
  return path;
}

describe.skipIf(process.platform === "win32")("node-pty spawn-helper modes", () => {
  it("makes the helpers published without the executable bit executable, content unchanged", () => {
    // The node-pty 1.1.0 tarball ships prebuilds/darwin-*/spawn-helper as 0644.
    const arm = helper("prebuilds/darwin-arm64", 0o644);
    const x64 = helper("prebuilds/darwin-x64", 0o644);
    const built = helper("build/Release", 0o755);
    expect(fixSpawnHelperModes(dir).sort()).toEqual([arm, x64].sort());
    for (const path of [arm, x64, built]) {
      expect(statSync(path).mode & 0o111).toBe(0o111);
      expect(readFileSync(path, "utf8")).toBe("binary");
    }
    expect(fixSpawnHelperModes(dir)).toEqual([]);
  });
});
