// The skills shipped with NOVA (BUILTIN_SKILL_NAMES), embedded as package data: no file to
// package, read-only, same format and same analysis as any other skill. Their instructions are
// written for the model (English, like the system prompt); the UI shows French names from its copy.
import type { BuiltinSkillName } from "@nova/shared";
import type { SkillFileEntry } from "./scan";

export interface BuiltinSkill {
  name: BuiltinSkillName;
  files: Readonly<Record<string, string>>;
}

const UNDERSTAND_REPO = `---
name: comprendre-un-depot
description: Build an accurate, sourced picture of an unfamiliar repository (purpose, layout, entry points, build and test commands, conventions) before changing anything. Use at the start of a mission on a project you have not read yet, or when the user asks how a codebase works.
version: "1.0"
allowed-tools: read_file list_dir glob search_text git_status git_diff
---

# Understand a repository

Goal: a short, verifiable map of the project that the next steps (and the user) can rely on.
Every statement you make must point to a file you actually read. Unknown stays unknown.

## Steps

1. **Orientation** — \`list_dir\` the root. Read the README, then the manifest(s) that exist
   (package.json, pyproject.toml, Cargo.toml, go.mod, pom.xml…). Note the language, the package
   manager and the declared scripts.
2. **Instructions for agents** — read AGENTS.md, CLAUDE.md or CONTRIBUTING.md when present: their
   rules override your habits.
3. **Layout** — \`glob\` for the source folders (e.g. \`src/**/*\`, \`packages/*/package.json\`). Identify
   the entry points (main, bin, server start, app root) and read them.
4. **Build and tests** — find how the project is built and tested (scripts, CI files under
   \`.github/workflows\`, test folders). Do not run anything in this skill: only record the commands.
5. **Conventions** — skim two or three representative files for naming, error handling, test style.
6. **Recent activity** — \`git_status\` (and \`git_diff\` when there are local changes) so you never
   overwrite the user's work in progress.

## Output

Answer with a compact map:

- Purpose (one sentence, from the README or manifest).
- Main folders and what they hold (one line each).
- Entry points (paths).
- Build / test / lint commands (exact, as declared).
- Conventions worth following.
- Open questions: what you could not confirm.

Keep it under 40 lines. Cite paths, never invent a file you did not see.
`;

const USEFUL_TESTS = `---
name: ecrire-des-tests-utiles
description: Write tests that catch real regressions of the behavior being changed, in the project's existing test framework and style, and prove they fail before the fix and pass after. Use when adding or fixing behavior that needs a test, or when the user asks for tests.
version: "1.0"
allowed-tools: read_file glob search_text write_file edit_file run_tests
---

# Write useful tests

A useful test names one behavior, fails for the right reason when that behavior breaks, and
passes on the correct code. Coverage for its own sake is not the goal.

## Steps

1. **Find the framework** — reuse what the project already uses (look at existing test files and
   the test script). Never add a new test library.
2. **Name the behavior** — write down, in one sentence, what must hold (input → expected output or
   effect). Prefer the public boundary (function exported, HTTP route, CLI) over internals.
3. **Place it** — next to the existing tests of that module, following their naming and structure.
4. **Write the smallest test** that expresses the behavior: realistic inputs, one clear assertion
   of the observable result. Add an edge case only when it is a real risk (empty input, boundary,
   error path).
5. **Prove it** — run the tests with \`run_tests\`:
   - on a bug fix, the new test must fail before the fix (for the expected reason) and pass after;
   - on new behavior, it must pass, and it must fail if you revert the key line (say so).
6. **Report** — list the tests added, the command run and its result. Never claim a test passes
   without having run it.

## Avoid

- Asserting on implementation details (private helpers, call counts) when a result can be checked.
- Snapshots of large outputs, sleeps, network access, shared global state between tests.
- Weakening an existing assertion to make a test pass.
`;

const RELEASE = `---
name: preparer-une-release
description: Prepare a release of the project safely - check the working tree and tests, determine the next version from the changes, update version files and the changelog, and hand the user the exact commands to tag and publish. Use when the user asks to prepare, cut or document a release.
version: "1.0"
allowed-tools: read_file glob search_text edit_file run_tests run_command git_status git_diff git_commit
---

# Prepare a release

NOVA never pushes, tags remotely or publishes on its own: this skill prepares everything and
leaves the irreversible steps to the user.

## Steps

1. **Clean state** — \`git_status\`: stop and tell the user if there are uncommitted changes that are
   not part of the release.
2. **Tests** — run the project's test command with \`run_tests\`. A failing suite stops the release;
   report the failures.
3. **What changed** — read the changelog (CHANGELOG.md, HISTORY.md, release notes) and the changes
   since the last release (\`git_diff\` against the last tag when the user gives it, or the commit
   messages the user shares). Group them: breaking changes, features, fixes.
4. **Next version** — follow the project's scheme (semver unless documented otherwise): breaking →
   major, feature → minor, fixes only → patch. State your reasoning; ask when it is ambiguous.
5. **Update files** — bump the version where the project declares it (manifest, version file) and
   add a changelog section with the date and the grouped changes, in the existing style.
6. **Verify** — run the tests again after the edits.
7. **Commit** — with \`git_commit\` only if the user's contract allows it, message
   \`release: vX.Y.Z\`.
8. **Hand over** — give the exact commands for the user to run: tag, push, publish. Do not run them.

## Output

Version chosen and why, files changed, test command and result, and the commands left to the user.
`;

export const BUILTIN_SKILLS: readonly BuiltinSkill[] = [
  { name: "comprendre-un-depot", files: { "SKILL.md": UNDERSTAND_REPO } },
  { name: "ecrire-des-tests-utiles", files: { "SKILL.md": USEFUL_TESTS } },
  { name: "preparer-une-release", files: { "SKILL.md": RELEASE } },
];

export function builtinEntries(skill: BuiltinSkill): SkillFileEntry[] {
  const encoder = new TextEncoder();
  return Object.entries(skill.files).map(([path, text]) => ({ path, bytes: encoder.encode(text) }));
}
