// Reading and analysing a skill folder. Nothing here executes a file.
//
// - `readSkillFolder` walks a folder on disk: regular files only, symlinks followed only when they
//   stay inside the folder (a link leaving it refuses the whole skill), `.git`/`node_modules`
//   skipped, C8-sensitive names and caller exclusions (`.novaignore`) never read (warned), and the
//   SKILL_LIMITS (file count, total size, depth) enforced while walking, before reading.
// - `analyzeSkill` is pure: front matter, declared permissions, warnings and a content hash that
//   changes whenever any file does (the hash the user saw is what enablement records).
import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import {
  BUILTIN_TOOL_NAMES,
  SKILL_LIMITS,
  isSensitivePath,
  redactSecrets,
  type RelativePath,
  type SkillDeclaredPermissions,
  type SkillFileInfo,
  type SkillWarning,
} from "@nova/shared";
import { SkillError, invalidSkill } from "./errors";
import { parseSkillMd, type SkillFrontMatter } from "./front-matter";

export const SKILL_MD = "SKILL.md";
/** Folders walked no deeper than this (a skill is a handful of files). */
export const SKILL_MAX_DEPTH = 8;
/** SKILL.md bodies above this are accepted but flagged (Agent Skills recommends < 5 000 tokens). */
export const SKILL_BODY_RECOMMENDED_CHARS = 20_000;
/** Folders never walked: repository metadata and dependencies are not part of a skill. */
const SKIPPED_DIRS = new Set([".git", "node_modules"]);

export interface SkillFileEntry {
  path: RelativePath;
  bytes: Uint8Array;
}

export interface ReadSkillFolderResult {
  entries: SkillFileEntry[];
  /** Files left out because they are sensitive or excluded (never read). */
  skipped: RelativePath[];
}

export interface AnalyzedSkill {
  frontMatter: SkillFrontMatter;
  body: string;
  files: SkillFileInfo[];
  declared: SkillDeclaredPermissions;
  warnings: SkillWarning[];
  contentHash: string;
  fileCount: number;
  totalBytes: number;
  /** Paths whose bytes contain a NUL (never returned as text). */
  binary: ReadonlySet<RelativePath>;
}

function isInside(root: string, absolute: string): boolean {
  if (absolute === root) return true;
  const rel = relative(root, absolute);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * Reads every file of a skill folder within SKILL_LIMITS. `isExcluded` receives paths relative to
 * the skill folder (the caller prefixes them for workspace rules). Throws `invalid_skill`.
 */
export async function readSkillFolder(
  folder: string,
  options: { isExcluded?: (path: RelativePath) => boolean | Promise<boolean> } = {},
): Promise<ReadSkillFolderResult> {
  let root: string;
  try {
    root = await realpath(folder);
    if (!(await stat(root)).isDirectory()) throw new Error("not a folder");
  } catch {
    throw invalidSkill("not_a_folder", "the skill folder does not exist or is not a folder");
  }
  const found: { path: RelativePath; absolute: string; size: number }[] = [];
  const skipped: RelativePath[] = [];
  let totalBytes = 0;

  const addFile = (path: RelativePath, absolute: string, size: number): void => {
    found.push({ path, absolute, size });
    totalBytes += size;
    if (found.length > SKILL_LIMITS.maxFiles) {
      throw invalidSkill("too_many_files", `a skill holds at most ${SKILL_LIMITS.maxFiles} files`);
    }
    if (totalBytes > SKILL_LIMITS.maxTotalBytes) {
      throw invalidSkill("too_large", `a skill holds at most ${SKILL_LIMITS.maxTotalBytes} bytes`);
    }
  };

  const walk = async (dir: string, base: RelativePath, depth: number): Promise<void> => {
    if (depth > SKILL_MAX_DEPTH) throw invalidSkill("too_deep", `a skill is at most ${SKILL_MAX_DEPTH} folders deep`, base);
    const names = (await readdir(dir)).sort();
    for (const name of names) {
      const path = base === "" ? name : `${base}/${name}`;
      const absolute = join(dir, name);
      const info = await lstat(absolute);
      if (info.isDirectory() && SKIPPED_DIRS.has(name)) continue;
      // C8: sensitive names and the caller's exclusions are never read, whatever they contain.
      if (isSensitivePath(path) || (await options.isExcluded?.(path))) {
        skipped.push(path);
        continue;
      }
      if (info.isSymbolicLink()) {
        let target: string;
        try {
          target = await realpath(absolute);
        } catch {
          throw invalidSkill("link_outside", "a link of the skill points to nothing", path);
        }
        if (!isInside(root, target)) throw invalidSkill("link_outside", "a link of the skill points outside its folder", path);
        const targetInfo = await stat(target);
        if (!targetInfo.isFile()) throw invalidSkill("unsupported_entry", "links to folders are not supported in a skill", path);
        addFile(path, target, targetInfo.size);
        continue;
      }
      if (info.isDirectory()) {
        await walk(absolute, path, depth + 1);
        continue;
      }
      if (!info.isFile()) throw invalidSkill("unsupported_entry", "a skill only holds files and folders", path);
      addFile(path, absolute, info.size);
    }
  };
  await walk(root, "", 0);

  const entries: SkillFileEntry[] = [];
  for (const file of found) entries.push({ path: file.path, bytes: await readFile(file.absolute) });
  // Sizes are checked again on the bytes actually read (a file may have grown since lstat).
  if (entries.reduce((sum, entry) => sum + entry.bytes.byteLength, 0) > SKILL_LIMITS.maxTotalBytes) {
    throw invalidSkill("too_large", `a skill holds at most ${SKILL_LIMITS.maxTotalBytes} bytes`);
  }
  return { entries, skipped };
}

function fileKind(path: RelativePath): SkillFileInfo["kind"] {
  if (path === SKILL_MD) return "skill_md";
  if (path.startsWith("scripts/")) return "script";
  if (path.startsWith("references/")) return "reference";
  if (path.startsWith("assets/")) return "asset";
  return "other";
}

function isBinary(bytes: Uint8Array): boolean {
  const end = Math.min(bytes.byteLength, 8_192);
  for (let index = 0; index < end; index += 1) if (bytes[index] === 0) return true;
  return false;
}

const KNOWN_TOOLS: ReadonlySet<string> = new Set(BUILTIN_TOOL_NAMES);

/** Validates and describes a skill from its files (pure; the order of `entries` does not matter). */
export function analyzeSkill(
  input: { entries: readonly SkillFileEntry[]; skipped?: readonly RelativePath[] },
  options: { folderName: string | null },
): AnalyzedSkill {
  const entries = [...input.entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (entries.length > SKILL_LIMITS.maxFiles) throw invalidSkill("too_many_files", `a skill holds at most ${SKILL_LIMITS.maxFiles} files`);
  const totalBytes = entries.reduce((sum, entry) => sum + entry.bytes.byteLength, 0);
  if (totalBytes > SKILL_LIMITS.maxTotalBytes) throw invalidSkill("too_large", `a skill holds at most ${SKILL_LIMITS.maxTotalBytes} bytes`);
  const skillMd = entries.find((entry) => entry.path === SKILL_MD);
  if (!skillMd) throw invalidSkill("missing_skill_md", "the folder has no SKILL.md at its root");
  if (isBinary(skillMd.bytes)) throw invalidSkill("invalid_front_matter", "SKILL.md is not a text file");
  const { frontMatter, body } = parseSkillMd(new TextDecoder().decode(skillMd.bytes));

  const warnings: SkillWarning[] = [];
  const binary = new Set<RelativePath>();
  const hash = createHash("sha256");
  for (const entry of entries) {
    hash.update(`${entry.path}\0${createHash("sha256").update(entry.bytes).digest("hex")}\n`);
    if (isBinary(entry.bytes)) {
      binary.add(entry.path);
      warnings.push({ code: "binary_files", subject: entry.path });
      continue;
    }
    const text = new TextDecoder().decode(entry.bytes);
    if (redactSecrets(text) !== text) warnings.push({ code: "secret_detected", subject: entry.path });
  }
  for (const path of input.skipped ?? []) warnings.push({ code: "secret_detected", subject: path });

  if (options.folderName !== null && options.folderName !== frontMatter.name) {
    warnings.push({ code: "name_mismatch", subject: options.folderName });
  }
  if (body.length > SKILL_BODY_RECOMMENDED_CHARS) warnings.push({ code: "too_large", subject: SKILL_MD });
  const scripts = entries.filter((entry) => fileKind(entry.path) === "script").map((entry) => entry.path);
  if (scripts.length > 0) warnings.push({ code: "has_scripts", subject: null });
  for (const host of frontMatter.hosts) warnings.push({ code: "network_hosts", subject: host });
  for (const tool of frontMatter.allowedTools) if (!KNOWN_TOOLS.has(tool)) warnings.push({ code: "unknown_tool", subject: tool });

  return {
    frontMatter,
    body,
    files: entries.map((entry) => ({ path: entry.path, size: entry.bytes.byteLength, kind: fileKind(entry.path) })),
    declared: { tools: frontMatter.allowedTools, hosts: frontMatter.hosts, scripts },
    warnings,
    contentHash: hash.digest("hex"),
    fileCount: entries.length,
    totalBytes,
    binary,
  };
}

/** A skill file's text for the model (or the preview), or a coded refusal. */
export function skillFileText(analyzed: AnalyzedSkill, entries: readonly SkillFileEntry[], path: RelativePath): string {
  const entry = entries.find((item) => item.path === path);
  if (!entry) throw new SkillError("not_found", `the skill has no file "${path}"`, { subject: path });
  if (analyzed.binary.has(path)) throw new SkillError("binary", `"${path}" is a binary file and cannot be read as text`, { subject: path });
  return new TextDecoder().decode(entry.bytes);
}
