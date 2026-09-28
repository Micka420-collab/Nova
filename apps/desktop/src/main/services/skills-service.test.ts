// skills.* over the real runtime and the real SQLite repo: picker flow, IPC error codes, workspace
// exclusions, and the mission-side views (tool API, skill index).
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSkillRepo, createWorkspaceRepo, openNovaStore, type NovaStore } from "@nova/storage";
import type { SkillsRuntime } from "@nova/skills";
import { ServiceError } from "../service-error";
import { createSkillsService, type SkillsService } from "./skills-service";

let store: NovaStore;
let dirs: string[];
let workspaceId: string;
let project: string;
let dataDir: string;
let picked: string | null;
let service: SkillsService;

function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "nova-skills-svc-")));
  dirs.push(dir);
  return dir;
}

function write(root: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, ...path.split("/"));
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
}

const skillMd = (name: string, extra = "") => `---\nname: ${name}\ndescription: The ${name} skill.\n${extra}---\n# ${name}\n`;

async function refusal(promise: Promise<unknown>): Promise<{ code: string; message: string }> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(ServiceError);
  return { code: (error as ServiceError).code, message: (error as ServiceError).message };
}

beforeEach(() => {
  dirs = [];
  store = openNovaStore(":memory:");
  project = tempDir();
  dataDir = tempDir();
  workspaceId = createWorkspaceRepo(store.db).upsertByRootPath({ rootPath: project, name: "p" }).id;
  picked = null;
  service = createSkillsService({
    skillsDir: join(dataDir, "skills"),
    repo: createSkillRepo(store.db),
    rootOf: async (id) => {
      if (id !== workspaceId) throw new ServiceError("not_found", "unknown workspace");
      return project;
    },
    pickFolder: async () => picked,
  });
});

afterEach(() => {
  store.close();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("skills service", () => {
  it("previews the picked folder, installs it, enables it and serves it to missions", async () => {
    expect(await service.api.preview({ source: { kind: "picker" } })).toBeNull();
    picked = join(tempDir(), "release-notes");
    write(picked, { "SKILL.md": skillMd("release-notes", "allowed-tools: read_file Bash\n"), "scripts/check.sh": "echo ok\n" });
    const preview = await service.api.preview({ source: { kind: "picker" } });
    expect(preview?.meta.ref).toBe("user:release-notes");
    expect(preview?.meta.declared.scripts).toEqual(["scripts/check.sh"]);
    expect(preview?.warnings).toEqual(expect.arrayContaining([{ code: "has_scripts", subject: null }, { code: "unknown_tool", subject: "Bash" }]));
    // The absolute path the user picked is never part of what the renderer gets.
    expect(JSON.stringify(preview)).not.toContain(picked);

    const meta = await service.api.install({ previewId: preview?.previewId ?? "" });
    expect(meta).toMatchObject({ ref: "user:release-notes", scope: "user", enabled: false, fileCount: 2 });
    expect(await service.skillIndex(workspaceId)).toBeNull();
    await service.api.setEnabled({ workspaceId, ref: "user:release-notes", enabled: true });
    expect((await service.api.list({ workspaceId })).find((skill) => skill.ref === "user:release-notes")?.enabled).toBe(true);
    expect((await service.tools.enabled(workspaceId)).map((skill) => skill.ref)).toEqual(["user:release-notes"]);
    expect(await service.skillIndex(workspaceId)).toContain("- user:release-notes (release-notes): The release-notes skill.");
    expect((await service.tools.load(workspaceId, "user:release-notes", "scripts/check.sh")).content).toBe("echo ok\n");

    await service.api.uninstall({ ref: "user:release-notes" });
    expect(readdirSync(join(dataDir, "skills"))).toEqual([]);
    expect(store.db.prepare("SELECT COUNT(*) AS n FROM skill_enablements").get()).toEqual({ n: 0 });
    expect(await service.skillIndex(workspaceId)).toBeNull();
  });

  it("refuses an invalid folder with a reason the renderer can explain", async () => {
    picked = join(tempDir(), "broken");
    write(picked, { "README.md": "no skill here" });
    expect(await refusal(service.api.preview({ source: { kind: "picker" } }))).toEqual({ code: "invalid_request", message: "skill_invalid:missing_skill_md" });
    write(picked, { "SKILL.md": "---\nname: Bad Name\ndescription: x\n---\n" });
    expect(await refusal(service.api.preview({ source: { kind: "picker" } }))).toEqual({ code: "invalid_request", message: "skill_invalid:invalid_name:Bad Name" });
    expect(existsSync(join(dataDir, "skills"))).toBe(false);
  });

  it("asks for a preview before enabling a project skill, and honors .novaignore", async () => {
    write(project, { ".nova/skills/deploy/SKILL.md": skillMd("deploy"), ".nova/skills/deploy/references/keys.md": "private\n", ".novaignore": "keys.md\n" });
    expect(await refusal(service.api.setEnabled({ workspaceId, ref: "project:deploy", enabled: true }))).toEqual({
      code: "conflict",
      message: "skill_preview_required",
    });
    const preview = await service.api.preview({ source: { kind: "project", workspaceId, name: "deploy" } });
    expect(preview?.files.map((file) => file.path)).toEqual(["SKILL.md"]);
    expect(await refusal(service.api.install({ previewId: preview?.previewId ?? "" }))).toMatchObject({ code: "invalid_request" });
    expect((await service.api.setEnabled({ workspaceId, ref: "project:deploy", enabled: true })).enabled).toBe(true);
    expect(await refusal(service.api.get({ ref: "project:nope", workspaceId }))).toMatchObject({ code: "not_found" });
    expect(await refusal(service.api.uninstall({ ref: "builtin:comprendre-un-depot" }))).toMatchObject({ code: "invalid_request" });
  });

  it("keeps missions going without skills when the index cannot be built, and says so in the log", async () => {
    const warnings: string[] = [];
    const failing = createSkillsService({
      skillsDir: join(dataDir, "skills"),
      repo: createSkillRepo(store.db),
      rootOf: async () => project,
      pickFolder: async () => null,
      logger: { info: () => {}, warn: (message) => warnings.push(message), error: () => {} },
      runtime: {
        ...({} as SkillsRuntime),
        skillIndex: () => Promise.reject(new Error("disk unreadable")),
      },
    });
    expect(await failing.skillIndex(workspaceId)).toBeNull();
    expect(warnings).toEqual(["skill index unavailable"]);
  });
});
