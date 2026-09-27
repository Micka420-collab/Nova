// Ignore and exclusion rules of a workspace.
//
// Two different questions (E1 vs C8):
// - `isIgnored`: greyed in the tree, skipped by the watcher and the quick-open index. Sources:
//   `.gitignore` files (root and nested, loaded lazily per directory), `.novaignore` at the root,
//   and the always-noisy folders `.git` and `node_modules`.
// - `isExcluded` (C8): never read, written or sent for the agent. Sources: `.novaignore`, the
//   sensitive defaults below (env files, keys, credentials) and `.git` / `node_modules`.
//   `.gitignore` alone does NOT exclude (build outputs are fine to read).
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import ignore, { type Ignore } from "ignore";
import type { RelativePath } from "@nova/shared";

/** Folders never walked nor watched, and excluded for the agent. */
export const ALWAYS_IGNORED_DIRS = [".git", "node_modules"] as const;

/**
 * C8 defaults: files that commonly hold secrets. gitignore syntax; `!` re-includes templates that
 * are meant to be committed (`.env.example`).
 */
export const SENSITIVE_DEFAULT_PATTERNS: readonly string[] = [
  ".git/",
  "node_modules/",
  ".env",
  ".env.*",
  "!.env.example",
  "!.env.sample",
  "!.env.template",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "*.jks",
  "*.keystore",
  "id_rsa*",
  "id_dsa*",
  "id_ecdsa*",
  "id_ed25519*",
  "!*.pub",
  ".ssh/",
  ".aws/",
  ".gnupg/",
  ".netrc",
  ".npmrc",
  ".pypirc",
  ".git-credentials",
  "credentials.json",
  "service-account*.json",
  "*.tfstate",
  "*.tfstate.*",
];

export interface IgnoreMatcher {
  /** Loads the `.gitignore` of `dir` and of its ancestors (idempotent, cached). */
  load(dir: RelativePath): Promise<void>;
  /** Drops cached rules (after a `.gitignore` / `.novaignore` change) so the next load rereads them. */
  invalidate(): void;
  /** Uses the rules loaded so far (call `load` for the parent directory first). */
  isIgnored(path: RelativePath, isDirectory: boolean): boolean;
  /** C8 exclusion; depends only on `.novaignore` and the defaults (call `load("")` once first). */
  isExcluded(path: RelativePath): boolean;
}

function ancestorsOf(dir: RelativePath): RelativePath[] {
  if (dir === "") return [""];
  const parts = dir.split("/");
  return ["", ...parts.map((_, index) => parts.slice(0, index + 1).join("/"))];
}

async function readRules(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
}

export function createIgnoreMatcher(root: string): IgnoreMatcher {
  // dir → rules of that dir's .gitignore (null = none). Paths are tested relative to their dir.
  let gitignores = new Map<RelativePath, Ignore | null>();
  let novaignore: Ignore | null = null;
  let excluded: Ignore = ignore().add(SENSITIVE_DEFAULT_PATTERNS);
  let rootLoaded = false;

  const loadRoot = async (): Promise<void> => {
    if (rootLoaded) return;
    const text = await readRules(join(root, ".novaignore"));
    novaignore = text === null ? null : ignore().add(text);
    excluded = ignore().add(SENSITIVE_DEFAULT_PATTERNS);
    if (text !== null) excluded.add(text);
    rootLoaded = true;
  };

  const test = (rules: Ignore, path: string, isDirectory: boolean): boolean =>
    path !== "" && rules.ignores(isDirectory ? `${path}/` : path);

  return {
    async load(dir) {
      await loadRoot();
      for (const ancestor of ancestorsOf(dir)) {
        if (gitignores.has(ancestor)) continue;
        const file = ancestor === "" ? join(root, ".gitignore") : join(root, ...ancestor.split("/"), ".gitignore");
        const text = await readRules(file);
        gitignores.set(ancestor, text === null ? null : ignore().add(text));
      }
    },

    invalidate() {
      gitignores = new Map();
      rootLoaded = false;
    },

    isIgnored(path, isDirectory) {
      const segments = path.split("/");
      if (segments.some((segment) => (ALWAYS_IGNORED_DIRS as readonly string[]).includes(segment))) return true;
      if (novaignore && test(novaignore, path, isDirectory)) return true;
      for (const [dir, rules] of gitignores) {
        if (!rules) continue;
        if (dir === "") {
          if (test(rules, path, isDirectory)) return true;
        } else if (path.startsWith(`${dir}/`) && test(rules, path.slice(dir.length + 1), isDirectory)) {
          return true;
        }
      }
      return false;
    },

    isExcluded(path) {
      if (path === "") return false;
      // Directory patterns (`.ssh/`) must also match the folder itself and everything below it.
      return excluded.ignores(path) || excluded.ignores(`${path}/`);
    },
  };
}
