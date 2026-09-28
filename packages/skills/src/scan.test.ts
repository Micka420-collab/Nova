import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SKILL_LIMITS } from "@nova/shared";
import { SkillError } from "./errors";
import { analyzeSkill, readSkillFolder } from "./scan";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "nova-skill-scan-")));
  dirs.push(dir);
  return dir;
}

function write(root: string, files: Record<string, string | Uint8Array>): void {
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, ...path.split("/"));
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
}

const SKILL_MD = "---\nname: demo\ndescription: A demo skill.\nallowed-tools: read_file Bash hosts\nhosts: [api.example.com]\n---\n# Demo\n";

async function refusal(promise: Promise<unknown>): Promise<{ code: string; reason: string | null; subject: string | null }> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(SkillError);
  const skillError = error as SkillError;
  return { code: skillError.code, reason: skillError.reason, subject: skillError.subject };
}

describe("readSkillFolder + analyzeSkill", () => {
  it("describes a valid skill: files by kind, declared permissions, warnings, stable hash", async () => {
    const root = join(tempDir(), "demo");
    write(root, {
      "SKILL.md": SKILL_MD,
      "scripts/run.sh": "#!/bin/sh\necho hi\n",
      "references/guide.md": "Guide\n",
      "assets/logo.bin": new Uint8Array([1, 0, 2]),
      ".git/config": "[core]\n",
      ".env": "TOKEN=abc\n",
      "references/notes.md": "key = sk-or-v1-FAKE-TEST-KEY-not-a-real-secret-000\n",
    });
    const read = await readSkillFolder(root);
    expect(read.entries.map((entry) => entry.path)).toEqual([
      "SKILL.md",
      "assets/logo.bin",
      "references/guide.md",
      "references/notes.md",
      "scripts/run.sh",
    ]);
    expect(read.skipped).toEqual([".env"]);
    const analyzed = analyzeSkill(read, { folderName: "demo" });
    expect(analyzed.files.map((file) => [file.path, file.kind])).toEqual([
      ["SKILL.md", "skill_md"],
      ["assets/logo.bin", "asset"],
      ["references/guide.md", "reference"],
      ["references/notes.md", "reference"],
      ["scripts/run.sh", "script"],
    ]);
    expect(analyzed.declared).toEqual({ tools: ["read_file", "Bash", "hosts"], hosts: ["api.example.com"], scripts: ["scripts/run.sh"] });
    expect(analyzed.warnings).toEqual([
      { code: "binary_files", subject: "assets/logo.bin" },
      { code: "secret_detected", subject: "references/notes.md" },
      { code: "secret_detected", subject: ".env" },
      { code: "has_scripts", subject: null },
      { code: "network_hosts", subject: "api.example.com" },
      { code: "unknown_tool", subject: "Bash" },
      { code: "unknown_tool", subject: "hosts" },
    ]);
    // Same files in another order → same hash; one byte changed → another hash.
    const again = analyzeSkill({ entries: [...read.entries].reverse() }, { folderName: "demo" });
    expect(again.contentHash).toBe(analyzed.contentHash);
    write(root, { "references/guide.md": "Guide!\n" });
    expect(analyzeSkill(await readSkillFolder(root), { folderName: "demo" }).contentHash).not.toBe(analyzed.contentHash);
  });

  it("flags a name that differs from its folder", async () => {
    const root = join(tempDir(), "other-name");
    write(root, { "SKILL.md": SKILL_MD });
    const analyzed = analyzeSkill(await readSkillFolder(root), { folderName: "other-name" });
    expect(analyzed.frontMatter.name).toBe("demo");
    expect(analyzed.warnings).toContainEqual({ code: "name_mismatch", subject: "other-name" });
  });

  it("refuses a folder without SKILL.md, or with an invalid one, with the reason", async () => {
    const empty = tempDir();
    write(empty, { "README.md": "x" });
    expect(() => analyzeSkill({ entries: [] }, { folderName: null })).toThrowError(SkillError);
    const missing = await readSkillFolder(empty).then((read) => {
      try {
        analyzeSkill(read, { folderName: null });
        return null;
      } catch (error) {
        return (error as SkillError).reason;
      }
    });
    expect(missing).toBe("missing_skill_md");
    expect(await refusal(readSkillFolder(join(empty, "nope")))).toMatchObject({ code: "invalid_skill", reason: "not_a_folder" });
  });

  it("refuses links leaving the folder, and follows links that stay inside", async () => {
    const base = tempDir();
    const root = join(base, "demo");
    write(root, { "SKILL.md": SKILL_MD, "references/a.md": "A\n" });
    write(base, { "secret.txt": "outside\n" });
    symlinkSync(join(root, "references", "a.md"), join(root, "references", "alias.md"));
    const inside = await readSkillFolder(root);
    expect(inside.entries.map((entry) => entry.path)).toContain("references/alias.md");
    symlinkSync(join(base, "secret.txt"), join(root, "references", "escape.md"));
    expect(await refusal(readSkillFolder(root))).toEqual({ code: "invalid_skill", reason: "link_outside", subject: "references/escape.md" });
  });

  it("bounds the number of files and the total size before reading them", async () => {
    const many = tempDir();
    const files: Record<string, string> = { "SKILL.md": SKILL_MD };
    for (let index = 0; index < SKILL_LIMITS.maxFiles; index += 1) files[`references/f${index}.md`] = "x";
    write(many, files);
    expect(await refusal(readSkillFolder(many))).toMatchObject({ reason: "too_many_files" });

    const big = tempDir();
    write(big, { "SKILL.md": SKILL_MD, "assets/big.bin": new Uint8Array(SKILL_LIMITS.maxTotalBytes) });
    expect(await refusal(readSkillFolder(big))).toMatchObject({ reason: "too_large" });
  });

  it("never reads files the caller excludes", async () => {
    const root = tempDir();
    write(root, { "SKILL.md": SKILL_MD, "private/notes.md": "secret plan\n" });
    const read = await readSkillFolder(root, { isExcluded: (path) => path.startsWith("private") });
    expect(read.entries.map((entry) => entry.path)).toEqual(["SKILL.md"]);
    expect(read.skipped).toEqual(["private"]);
  });
});
