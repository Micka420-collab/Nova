// Project facts (E1, reused by F2/A3/A4): detected from marker files at the root only
// (package.json scripts and dependencies, lockfiles, pyproject.toml, Cargo.toml, go.mod,
// index.html). Nothing is executed; anything not proven by a marker stays null / absent.
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { CommandArgv, PackageManager, RelativePath, TestRunnerName, WorkspaceFacts } from "@nova/shared";

const MARKER_MAX_BYTES = 1024 * 1024;

export const INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md", ".cursorrules"] as const;

type JsPackageManager = Extract<PackageManager, "npm" | "pnpm" | "yarn" | "bun">;

/** Lockfile → package manager, first match wins (a repo with two lockfiles is rare and ambiguous). */
const JS_LOCKFILES: readonly [string, JsPackageManager][] = [
  ["pnpm-lock.yaml", "pnpm"],
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
  ["npm-shrinkwrap.json", "npm"],
];

/** Dependency name → framework identifier. */
const JS_FRAMEWORKS: readonly [string, string][] = [
  ["next", "next"],
  ["nuxt", "nuxt"],
  ["astro", "astro"],
  ["@sveltejs/kit", "sveltekit"],
  ["svelte", "svelte"],
  ["vue", "vue"],
  ["react", "react"],
  ["solid-js", "solid"],
  ["@angular/core", "angular"],
  ["vite", "vite"],
  ["electron", "electron"],
  ["express", "express"],
];

const PY_FRAMEWORKS = ["django", "fastapi", "flask"] as const;

interface PackageJson {
  scripts: Record<string, string>;
  dependencies: Set<string>;
  packageManagerField: JsPackageManager | null;
}

async function readMarker(root: string, name: string): Promise<string | null> {
  const file = join(root, name);
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > MARKER_MAX_BYTES) return null;
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
}

async function exists(root: string, name: string): Promise<boolean> {
  try {
    await stat(join(root, name));
    return true;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parsePackageJson(text: string): PackageJson | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(raw)) return null;
  const scripts: Record<string, string> = {};
  if (isRecord(raw["scripts"])) {
    for (const [name, value] of Object.entries(raw["scripts"])) if (typeof value === "string") scripts[name] = value;
  }
  const dependencies = new Set<string>();
  for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    const deps = raw[field];
    if (isRecord(deps)) for (const name of Object.keys(deps)) dependencies.add(name);
  }
  const field = typeof raw["packageManager"] === "string" ? raw["packageManager"].split("@")[0] : null;
  const packageManagerField = field === "pnpm" || field === "yarn" || field === "npm" || field === "bun" ? field : null;
  return { scripts, dependencies, packageManagerField };
}

/** argv running a package.json script with the given manager. */
export function scriptCommand(manager: JsPackageManager, script: string): CommandArgv {
  if (manager === "npm") return script === "test" ? ["npm", "test"] : ["npm", "run", script];
  return [manager, "run", script];
}

/** argv running a binary installed in node_modules/.bin. */
function binCommand(manager: JsPackageManager, bin: string, args: string[]): CommandArgv {
  switch (manager) {
    case "pnpm":
      return ["pnpm", "exec", bin, ...args];
    case "yarn":
      return ["yarn", bin, ...args];
    case "bun":
      return ["bunx", bin, ...args];
    case "npm":
      return ["npx", "--no-install", bin, ...args];
  }
}

const NPM_PLACEHOLDER_TEST = /no test specified/i;

function jsTestRunner(pkg: PackageJson, manager: JsPackageManager): WorkspaceFacts["testRunner"] {
  const script = pkg.scripts["test"];
  const usable = script !== undefined && !NPM_PLACEHOLDER_TEST.test(script);
  const named = (name: "vitest" | "jest"): boolean => (usable && script.includes(name)) || pkg.dependencies.has(name);
  const name: TestRunnerName | null = named("vitest") ? "vitest" : named("jest") ? "jest" : usable ? "other" : null;
  if (name === null) return null;
  if (usable) return { name, command: scriptCommand(manager, "test") };
  // A runner dependency without a test script: call it directly, non-interactive.
  return { name, command: binCommand(manager, name, name === "vitest" ? ["run"] : ["--ci"]) };
}

export interface FactsDetectorOptions {
  /** Whether the root is inside a Git work tree (the git client answers; false when git is absent). */
  isGitRepo: (root: string) => Promise<boolean>;
  now?: () => number;
}

export async function detectWorkspaceFacts(
  root: string,
  workspaceId: string,
  options: FactsDetectorOptions,
): Promise<WorkspaceFacts> {
  const now = options.now ?? Date.now;
  const [packageText, pyproject, requirements, cargo, goMod, hasIndexHtml, hasTsconfig, git] = await Promise.all([
    readMarker(root, "package.json"),
    readMarker(root, "pyproject.toml"),
    readMarker(root, "requirements.txt"),
    exists(root, "Cargo.toml"),
    exists(root, "go.mod"),
    exists(root, "index.html"),
    exists(root, "tsconfig.json"),
    options.isGitRepo(root).catch(() => false),
  ]);

  const languages = new Set<string>();
  const frameworks: string[] = [];
  let packageManager: PackageManager | null = null;
  let testRunner: WorkspaceFacts["testRunner"] = null;
  let devCommand: CommandArgv | null = null;
  let buildCommand: CommandArgv | null = null;

  const pkg = packageText === null ? null : parsePackageJson(packageText);
  if (pkg) {
    languages.add(hasTsconfig || pkg.dependencies.has("typescript") ? "typescript" : "javascript");
    let jsManager: JsPackageManager | null = null;
    for (const [lockfile, manager] of JS_LOCKFILES) {
      if (await exists(root, lockfile)) {
        jsManager = manager;
        break;
      }
    }
    jsManager ??= pkg.packageManagerField;
    packageManager = jsManager;
    for (const [dependency, framework] of JS_FRAMEWORKS) {
      if (pkg.dependencies.has(dependency) && !frameworks.includes(framework)) frameworks.push(framework);
    }
    // Commands need a known manager: guessing npm in a pnpm repo would install a second lockfile.
    if (jsManager) {
      testRunner = jsTestRunner(pkg, jsManager);
      const dev = pkg.scripts["dev"] !== undefined ? "dev" : pkg.scripts["start"] !== undefined ? "start" : null;
      if (dev) devCommand = scriptCommand(jsManager, dev);
      if (pkg.scripts["build"] !== undefined) buildCommand = scriptCommand(jsManager, "build");
    }
  }

  const pythonText = `${pyproject ?? ""}\n${requirements ?? ""}`.toLowerCase();
  if (pyproject !== null || requirements !== null) {
    languages.add("python");
    const [uvLock, poetryLock, pytestIni, conftest] = await Promise.all([
      exists(root, "uv.lock"),
      exists(root, "poetry.lock"),
      exists(root, "pytest.ini"),
      exists(root, "conftest.py"),
    ]);
    const pyManager: PackageManager | null = uvLock
      ? "uv"
      : poetryLock || pythonText.includes("[tool.poetry]")
        ? "poetry"
        : requirements !== null
          ? "pip"
          : null;
    packageManager ??= pyManager;
    for (const framework of PY_FRAMEWORKS) if (new RegExp(`\\b${framework}\\b`).test(pythonText)) frameworks.push(framework);
    if (testRunner === null && (pytestIni || conftest || /\bpytest\b/.test(pythonText))) {
      const command: CommandArgv =
        pyManager === "uv"
          ? ["uv", "run", "pytest"]
          : pyManager === "poetry"
            ? ["poetry", "run", "pytest"]
            : ["python", "-m", "pytest"];
      testRunner = { name: "pytest", command };
    }
  }

  if (cargo) {
    languages.add("rust");
    packageManager ??= "cargo";
    testRunner ??= { name: "cargo", command: ["cargo", "test"] };
    buildCommand ??= ["cargo", "build"];
  }
  if (goMod) {
    languages.add("go");
    packageManager ??= "go";
    testRunner ??= { name: "go", command: ["go", "test", "./..."] };
    buildCommand ??= ["go", "build", "./..."];
  }
  if (hasIndexHtml) languages.add("html");

  const instructionFiles: RelativePath[] = [];
  for (const name of INSTRUCTION_FILES) if (await exists(root, name)) instructionFiles.push(name);

  return {
    workspaceId,
    detectedAt: now(),
    packageManager,
    languages: [...languages],
    frameworks,
    testRunner,
    devCommand,
    buildCommand,
    git,
    instructionFiles,
  };
}
