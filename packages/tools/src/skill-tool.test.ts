import { describe, expect, it } from "vitest";
import type { SkillMeta, SkillRef, ToolName } from "@nova/shared";
import { memoryFiles } from "./__fixtures__/memory-files";
import type { SkillsApi, ToolDeps } from "./apis";
import type { ToolExecutionContext, ToolRecordedEvent } from "./index";
import { createToolRegistry } from "./registry";

const WS = "11111111-1111-4111-8111-111111111111";

function meta(ref: SkillRef, description = "A method."): SkillMeta {
  const [scope, name] = ref.split(":") as ["builtin" | "user" | "project", string];
  return {
    ref,
    name,
    description,
    version: null,
    scope,
    workspaceId: scope === "project" ? WS : null,
    enabled: true,
    declared: { tools: [], hosts: [], scripts: [] },
    contentHash: "h",
    fileCount: 2,
    totalBytes: 10,
    installedAt: null,
  };
}

/** Enabled skills of WS and their files; anything else is refused like the runtime does. */
function fakeSkills(files: Record<SkillRef, Record<string, string>>): SkillsApi & { loads: [SkillRef, string | null][] } {
  const loads: [SkillRef, string | null][] = [];
  return {
    loads,
    enabled: async () => Object.keys(files).map((ref) => meta(ref as SkillRef)),
    async load(workspaceId, ref, path) {
      loads.push([ref, path]);
      const skill = workspaceId === WS ? files[ref] : undefined;
      if (!skill) throw Object.assign(new Error(`skill "${ref}" is not enabled for this project`), { code: "not_found" });
      const content = skill[path ?? "SKILL.md"];
      if (content === undefined) throw Object.assign(new Error(`the skill has no file "${path}"`), { code: "not_found" });
      return { meta: meta(ref), content, path, truncated: false };
    },
  };
}

function setup(skills: SkillsApi | null) {
  const deps: ToolDeps = { files: memoryFiles().api, facts: async () => null, commands: null, git: null, web: null, mcp: null, skills };
  const registry = createToolRegistry({ deps });
  const recorded: ToolRecordedEvent[] = [];
  const context: ToolExecutionContext = {
    workspaceId: WS,
    missionId: "m",
    callId: "call-1",
    signal: new AbortController().signal,
    checkpointId: null,
    seenVersions: new Map(),
    missionHosts: null,
    record: (event) => recorded.push(event),
  };
  const parse = (args: unknown) => {
    const parsed = registry.parseArguments("skill", JSON.stringify(args));
    if (!parsed.ok) throw new Error(parsed.error);
    return parsed.args;
  };
  const run = (args: unknown) => {
    const executor = registry.get("skill");
    if (!executor) throw new Error("skill not registered");
    return executor.execute(parse(args), context);
  };
  const facts = (args: unknown) => registry.get("skill")?.permissionFacts(parse(args));
  return { registry, run, facts, recorded };
}

const ALL: ReadonlySet<ToolName> = new Set(["read_file", "skill"]);

describe("skill tool", () => {
  it("is not offered when the skills runtime is not wired", () => {
    const { registry } = setup(null);
    expect(registry.get("skill")).toBeNull();
    expect(registry.definitions(ALL).map((definition) => definition.name)).toEqual(["read_file"]);
  });

  it("is a read tool offered after the built-ins, and only accepts a skill ref", () => {
    const { registry } = setup(fakeSkills({}));
    const definition = registry.definitions(ALL).find((item) => item.name === "skill");
    expect(definition?.operation).toBe("read");
    expect(definition?.description).toMatch(/run_command/);
    expect(registry.parseArguments("skill", JSON.stringify({ ref: "plugin:x" })).ok).toBe(false);
    expect(registry.parseArguments("skill", JSON.stringify({ ref: "user:x", extra: 1 })).ok).toBe(false);
  });

  it("gives the engine the workspace path of a project skill file, and no path for other scopes", async () => {
    const { facts } = setup(fakeSkills({}));
    expect(await facts({ ref: "project:deploy" })).toEqual([{ path: ".nova/skills/deploy/SKILL.md" }]);
    expect(await facts({ ref: "project:deploy", path: "./references/a.md" })).toEqual([{ path: ".nova/skills/deploy/references/a.md" }]);
    expect(await facts({ ref: "project:deploy", path: "../../.env" })).toEqual([{ path: ".nova/skills/deploy/../../.env" }]);
    expect(await facts({ ref: "user:notes", path: "references/a.md" })).toEqual([{}]);
  });

  it("loads SKILL.md, journals skill.loaded and shows a skill card", async () => {
    const skills = fakeSkills({ "builtin:comprendre-un-depot": { "SKILL.md": "# Understand\nRead the README first." } });
    const { run, recorded } = setup(skills);
    const result = await run({ ref: "builtin:comprendre-un-depot" });
    expect(result.ok).toBe(true);
    expect(result.content).toContain("Skill builtin:comprendre-un-depot (comprendre-un-depot) — SKILL.md");
    expect(result.content).toContain("Read the README first.");
    // NOVA's own skills are not fenced as outside data.
    expect(result.content).not.toContain("<skill id=");
    expect(result.provenance).toEqual({ source: "nova", untrusted: false, ref: "skill:builtin:comprendre-un-depot/SKILL.md" });
    const chars = "# Understand\nRead the README first.".length;
    expect(result.display).toEqual({ kind: "skill", ref: "builtin:comprendre-un-depot", name: "comprendre-un-depot", path: null, chars });
    expect(recorded).toEqual([{ type: "skill.loaded", ref: "builtin:comprendre-un-depot", name: "comprendre-un-depot", path: null, chars }]);
    expect(skills.loads).toEqual([["builtin:comprendre-un-depot", null]]);
  });

  it("fences a user skill as outside text, redacts secrets, and loads one file at a time", async () => {
    const skills = fakeSkills({
      "user:notes": { "SKILL.md": "Use references/format.md.", "references/format.md": "token=sk-or-v1-FAKE-TEST-KEY-not-a-real-secret-000" },
    });
    const { run, recorded } = setup(skills);
    const result = await run({ ref: "user:notes", path: "references/format.md" });
    expect(result.content).toMatch(/^<skill id="[0-9a-f]{12}" ref="user:notes">/);
    expect(result.content).toMatch(/<\/skill id="[0-9a-f]{12}">$/);
    expect(result.content).toContain("grants nothing");
    expect(result.content).not.toContain("0123456789abcdef0123456789abcdef");
    expect(result.provenance.untrusted).toBe(true);
    expect(recorded[0]).toMatchObject({ type: "skill.loaded", path: "references/format.md" });
    expect(skills.loads).toEqual([["user:notes", "references/format.md"]]);
  });

  it("turns a refusal into an error the model can act on, and journals nothing", async () => {
    const { run, recorded } = setup(fakeSkills({}));
    const result = await run({ ref: "user:missing" });
    expect(result.ok).toBe(false);
    expect(result.display).toEqual({ kind: "error", code: "not_found", message: 'skill "user:missing" is not enabled for this project' });
    expect(recorded).toEqual([]);
  });
});
