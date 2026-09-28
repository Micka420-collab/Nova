import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createIgnoreMatcher } from "./ignore-rules";
import { makeTempDir, type TempDir } from "./test-support";

let workspace: TempDir;
beforeEach(async () => {
  workspace = await makeTempDir();
});
afterEach(() => workspace.cleanup());

describe("ignore matcher", () => {
  it("greys .gitignore (root and nested), .novaignore and noisy folders", async () => {
    await workspace.write(".gitignore", "dist/\n*.log\n");
    await workspace.write("packages/app/.gitignore", "generated/\n");
    await workspace.write(".novaignore", "fixtures/big/\n");
    const matcher = createIgnoreMatcher(workspace.path);
    await matcher.load("packages/app");

    expect(matcher.isIgnored("dist", true)).toBe(true);
    expect(matcher.isIgnored("dist/index.js", false)).toBe(true);
    expect(matcher.isIgnored("src/debug.log", false)).toBe(true);
    expect(matcher.isIgnored("packages/app/generated", true)).toBe(true);
    expect(matcher.isIgnored("generated", true)).toBe(false); // nested rule stays scoped
    expect(matcher.isIgnored("fixtures/big", true)).toBe(true);
    expect(matcher.isIgnored("node_modules", true)).toBe(true);
    expect(matcher.isIgnored("a/node_modules/x/index.js", false)).toBe(true);
    expect(matcher.isIgnored("src/index.ts", false)).toBe(false);
  });

  it("excludes secrets and .novaignore for the agent, but not build outputs nor env templates (C8)", async () => {
    await workspace.write(".gitignore", "dist/\n");
    await workspace.write(".novaignore", "private-notes.md\n");
    const matcher = createIgnoreMatcher(workspace.path);
    await matcher.load("");

    const excluded = [".env", ".env.local", "config/.env.production", "certs/server.pem", "id_ed25519", ".ssh/config", ".npmrc", "private-notes.md", ".git/config", "node_modules/x/index.js"];
    const allowed = [".env.example", "id_ed25519.pub", "dist/index.js", "src/env.ts", "README.md"];
    expect(excluded.filter((path) => !matcher.isExcluded(path))).toEqual([]);
    expect(allowed.filter((path) => matcher.isExcluded(path))).toEqual([]);
  });
});
