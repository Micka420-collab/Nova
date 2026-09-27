import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectWorkspaceFacts } from "./facts";
import { makeTempDir, type TempDir } from "./test-support";

let workspace: TempDir;
beforeEach(async () => {
  workspace = await makeTempDir();
});
afterEach(() => workspace.cleanup());

const detect = (git = false) =>
  detectWorkspaceFacts(workspace.path, "ws", { isGitRepo: async () => git, now: () => 7 });

describe("project facts", () => {
  it("detects a pnpm + Vite + React + Vitest project from its markers", async () => {
    await workspace.write(
      "package.json",
      JSON.stringify({
        scripts: { dev: "vite", build: "vite build", test: "vitest run" },
        dependencies: { react: "^19" },
        devDependencies: { vite: "^7", vitest: "^5", typescript: "^5" },
      }),
    );
    await workspace.write("pnpm-lock.yaml", "");
    await workspace.write("index.html", "<!doctype html>");
    await workspace.write("AGENTS.md", "# rules");
    expect(await detect(true)).toEqual({
      workspaceId: "ws",
      detectedAt: 7,
      packageManager: "pnpm",
      languages: ["typescript", "html"],
      frameworks: ["react", "vite"],
      testRunner: { name: "vitest", command: ["pnpm", "run", "test"] },
      devCommand: ["pnpm", "run", "dev"],
      buildCommand: ["pnpm", "run", "build"],
      git: true,
      instructionFiles: ["AGENTS.md"],
    });
  });

  it("keeps unknowns null: no lockfile means no guessed manager nor commands", async () => {
    await workspace.write("package.json", JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }));
    const facts = await detect();
    expect(facts).toMatchObject({ packageManager: null, testRunner: null, devCommand: null, buildCommand: null, git: false });
    expect(facts.languages).toEqual(["javascript"]);
  });

  it("uses the jest binary when there is no test script, and the manager of the lockfile", async () => {
    await workspace.write("package.json", JSON.stringify({ devDependencies: { jest: "^30", next: "^16" }, scripts: { start: "next start" } }));
    await workspace.write("yarn.lock", "");
    expect(await detect()).toMatchObject({
      packageManager: "yarn",
      frameworks: ["next"],
      testRunner: { name: "jest", command: ["yarn", "jest", "--ci"] },
      devCommand: ["yarn", "run", "start"],
    });
  });

  it("detects Python (uv, pytest, fastapi), Rust and Go projects", async () => {
    await workspace.write("pyproject.toml", '[project]\ndependencies = ["fastapi"]\n[dependency-groups]\ndev = ["pytest"]\n');
    await workspace.write("uv.lock", "");
    expect(await detect()).toMatchObject({
      packageManager: "uv",
      languages: ["python"],
      frameworks: ["fastapi"],
      testRunner: { name: "pytest", command: ["uv", "run", "pytest"] },
    });

    const rust = await makeTempDir();
    await rust.write("Cargo.toml", "[package]\nname = \"x\"\n");
    await rust.write("go.mod", "module x\n");
    const facts = await detectWorkspaceFacts(rust.path, "r", { isGitRepo: async () => false });
    expect(facts).toMatchObject({
      packageManager: "cargo",
      languages: ["rust", "go"],
      testRunner: { name: "cargo", command: ["cargo", "test"] },
      buildCommand: ["cargo", "build"],
    });
    await rust.cleanup();
  });
});
