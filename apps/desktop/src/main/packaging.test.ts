// Packaging contract: native optional dependencies (the `@vscode/ripgrep-<platform>-<arch>` binary)
// are installed for the host cpu only, so every shipped mac arch must be packed on a runner of that
// arch and self-tested there. An x64 app packed on Apple Silicon ships without ripgrep.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (relative: string): string => readFileSync(new URL(relative, import.meta.url), "utf8");

/** Lines of a top-level YAML block (`key:` at column 0) up to the next top-level key. */
function topLevelBlock(yaml: string, key: string): string[] {
  const lines = yaml.split("\n");
  const start = lines.findIndex((line) => line === `${key}:` || line.startsWith(`${key}: `));
  if (start < 0) return [];
  const end = lines.findIndex((line, index) => index > start && /^[A-Za-z]/.test(line));
  return lines.slice(start, end < 0 ? undefined : end);
}

describe("release packaging per arch", () => {
  const builder = read("../../electron-builder.yml");
  const release = read("../../../../.github/workflows/release.yml");

  it("packs the mac app for the runner's own arch only", () => {
    const mac = topLevelBlock(builder, "mac");
    expect(mac.length).toBeGreaterThan(0);
    expect(mac.filter((line) => /^\s*-?\s*arch\s*:/.test(line) && !line.trimStart().startsWith("#"))).toEqual([]);
  });

  it("builds on an Apple Silicon and an Intel mac runner", () => {
    const matrix = release.split("\n").find((line) => /^\s+os:\s*\[/.test(line)) ?? "";
    expect(matrix).toContain("macos-latest");
    expect(matrix).toContain("macos-15-intel");
  });

  it("self-tests the packaged app on every release runner", () => {
    expect(release).toContain("node e2e/packaged-selftest.mjs");
  });
});
