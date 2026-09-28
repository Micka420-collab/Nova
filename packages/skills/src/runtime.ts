// SkillsRuntime (M8): the three sources, previews, install/uninstall, per-project enablement and
// progressive loading. Lives in main; the renderer reaches it only through `skills.*`.
//
// Invariants:
// - Writes happen only under `skillsDir` (<dataDir>/skills): install goes through a temporary
//   folder renamed into place; replace and uninstall first move the old folder aside, so a failure
//   never leaves half a skill. Leftovers of a crash are removed by `init()`.
// - Install installs exactly the bytes shown in the preview (kept in memory, single use, TTL).
// - Enablement records the content hash the user saw; a skill whose content changed since (a
//   project skill edited on disk, a user skill replaced or tampered with) is no longer enabled
//   until the user reviews it again. A project skill is never enabled without a preview of its
//   current content.
// - Project skills are read in `<root>/.nova/skills/<name>`, confined to the workspace (a folder
//   resolving outside it is ignored) with the workspace C8 exclusions applied to every file.
import { randomUUID } from "node:crypto";
import { mkdir, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import {
  SKILL_LIMITS,
  SKILL_NAME_PATTERN,
  isCanonicalRelativePath,
  skillRef,
  type RelativePath,
  type SkillDeclaredPermissions,
  type SkillDetail,
  type SkillMeta,
  type SkillPreview,
  type SkillRef,
  type SkillScope,
} from "@nova/shared";
import type { SkillLoadOutcome } from "@nova/tools";
import { BUILTIN_SKILLS, builtinEntries, type BuiltinSkill } from "./builtin";
import { SkillError } from "./errors";
import { SKILL_MD, analyzeSkill, readSkillFolder, skillFileText, type AnalyzedSkill, type SkillFileEntry } from "./scan";
import { formatSkillIndex } from "./skill-index";
import type { SkillPreviewSource, SkillsRuntime } from "./index";

/** Where project skills live, relative to the workspace root. */
export const PROJECT_SKILLS_DIR = ".nova/skills";
/** A preview can be installed during this long. */
export const PREVIEW_TTL_MS = 30 * 60_000;
/** Previews kept at once (each holds at most SKILL_LIMITS.maxTotalBytes in memory). */
export const MAX_PENDING_PREVIEWS = 8;
const TEMP_PREFIX = ".tmp-";
const TRASH_PREFIX = ".trash-";

/** Structural subset of @nova/storage `SkillRepo` (createSkillRepo satisfies it). */
export interface SkillsRepoPort {
  upsertInstalled(input: {
    name: string;
    description: string;
    version: string | null;
    declared: SkillDeclaredPermissions;
    contentHash: string;
    fileCount: number;
    totalBytes: number;
    installDir: string;
  }): { installedAt: number };
  getInstalled(name: string): InstalledSkillRow | null;
  listInstalled(): InstalledSkillRow[];
  uninstall(name: string): boolean;
  setEnabled(workspaceId: string, ref: SkillRef, enabled: boolean, contentHash: string | null): unknown;
  enablement(workspaceId: string, ref: SkillRef): { enabled: boolean; contentHash: string | null } | null;
  listEnablements(workspaceId: string): { ref: SkillRef; enabled: boolean; contentHash: string | null }[];
}

export interface InstalledSkillRow {
  name: string;
  description: string;
  version: string | null;
  declared: SkillDeclaredPermissions;
  contentHash: string;
  fileCount: number;
  totalBytes: number;
  installDir: string;
  installedAt: number;
}

/** Workspace access for project skills (main passes the workspace registry and its C8 matcher). */
export interface ProjectSkillsAccess {
  /** Canonical root of a known workspace; throws when unknown. */
  root(workspaceId: string): Promise<string>;
  /** C8 exclusion of a workspace-relative path (`.novaignore` + sensitive defaults). */
  isExcluded(workspaceId: string, path: RelativePath): Promise<boolean>;
}

export interface SkillsRuntimeDeps {
  /** `<dataDir>/skills`: the only folder the runtime writes to. */
  skillsDir: string;
  repo: SkillsRepoPort;
  projects: ProjectSkillsAccess;
  /** Tests replace the shipped skills. */
  builtins?: readonly BuiltinSkill[];
  now?: () => number;
  newId?: () => string;
  /** Leftovers or rows that `init()` repaired (never content). */
  onRepair?: (what: { kind: "temp_removed" | "orphan_folder_removed" | "missing_folder_row_removed"; name: string }) => void;
}

/** One resolved skill: its analysis and its files (bytes), from any source. */
interface LoadedSkill {
  ref: SkillRef;
  scope: SkillScope;
  name: string;
  workspaceId: string | null;
  installedAt: number | null;
  analyzed: AnalyzedSkill;
  entries: readonly SkillFileEntry[];
}

interface PendingPreview {
  id: string;
  expiresAt: number;
  loaded: LoadedSkill;
  source: SkillPreviewSource["kind"];
}

function isInside(root: string, absolute: string): boolean {
  if (absolute === root) return true;
  const rel = relative(root, absolute);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function parseRef(ref: SkillRef): { scope: SkillScope; name: string } {
  const index = ref.indexOf(":");
  const scope = ref.slice(0, index) as SkillScope;
  const name = ref.slice(index + 1);
  if (!["builtin", "user", "project"].includes(scope) || !SKILL_NAME_PATTERN.test(name)) {
    throw new SkillError("not_found", `unknown skill "${ref}"`);
  }
  return { scope, name };
}

function sortByRef<T extends { ref: SkillRef }>(items: T[]): T[] {
  return items.sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
}

/** Head of a text within `max` characters, with an explicit marker when cut. */
function capHead(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  const marker = `\n[… truncated: ${text.length - max} more characters]`;
  return { text: text.slice(0, Math.max(0, max - marker.length)) + marker, truncated: true };
}

export function createSkillsRuntime(deps: SkillsRuntimeDeps): SkillsRuntime {
  const now = deps.now ?? Date.now;
  const newId = deps.newId ?? randomUUID;
  const builtins = deps.builtins ?? BUILTIN_SKILLS;
  const previews = new Map<string, PendingPreview>();
  /** `${workspaceId}\0${name}` → hash of the last preview of that project skill. */
  const reviewedProject = new Map<string, string>();

  const toMeta = (loaded: LoadedSkill, enabled: boolean): SkillMeta => ({
    ref: loaded.ref,
    name: loaded.name,
    description: loaded.analyzed.frontMatter.description,
    version: loaded.analyzed.frontMatter.version,
    scope: loaded.scope,
    workspaceId: loaded.workspaceId,
    enabled,
    declared: loaded.analyzed.declared,
    contentHash: loaded.analyzed.contentHash,
    fileCount: loaded.analyzed.fileCount,
    totalBytes: loaded.analyzed.totalBytes,
    installedAt: loaded.installedAt,
  });

  const toDetail = (loaded: LoadedSkill, enabled: boolean): SkillDetail => ({
    meta: toMeta(loaded, enabled),
    content: capHead(loaded.analyzed.body, SKILL_LIMITS.skillMdMaxChars).text,
    files: loaded.analyzed.files,
    warnings: loaded.analyzed.warnings,
  });

  // --- sources -------------------------------------------------------------------------------

  const loadBuiltin = (name: string): LoadedSkill => {
    const skill = builtins.find((item) => item.name === name);
    if (!skill) throw new SkillError("not_found", `unknown skill "builtin:${name}"`);
    const entries = builtinEntries(skill);
    return {
      ref: skillRef("builtin", name),
      scope: "builtin",
      name,
      workspaceId: null,
      installedAt: null,
      analyzed: analyzeSkill({ entries }, { folderName: name }),
      entries,
    };
  };

  const userDir = (name: string): string => join(deps.skillsDir, name);

  const loadUser = async (name: string): Promise<LoadedSkill> => {
    const row = deps.repo.getInstalled(name);
    if (!row) throw new SkillError("not_found", `unknown skill "user:${name}"`);
    const read = await readSkillFolder(join(deps.skillsDir, row.installDir)).catch(() => {
      throw new SkillError("not_found", `the files of "user:${name}" are missing; reinstall it`);
    });
    return {
      ref: skillRef("user", name),
      scope: "user",
      name,
      workspaceId: null,
      installedAt: row.installedAt,
      analyzed: analyzeSkill(read, { folderName: name }),
      entries: read.entries,
    };
  };

  /** Absolute folder of a project skill, confined to the workspace; null when absent or outside. */
  const projectFolder = async (workspaceId: string, name: string): Promise<{ root: string; folder: string } | null> => {
    const root = await deps.projects.root(workspaceId);
    try {
      const folder = await realpath(join(root, ...PROJECT_SKILLS_DIR.split("/"), name));
      return isInside(root, folder) ? { root, folder } : null;
    } catch {
      return null;
    }
  };

  const loadProject = async (workspaceId: string, name: string): Promise<LoadedSkill> => {
    const place = await projectFolder(workspaceId, name);
    if (!place) throw new SkillError("not_found", `unknown skill "project:${name}"`);
    const prefix = `${PROJECT_SKILLS_DIR}/${name}`;
    if (await deps.projects.isExcluded(workspaceId, prefix)) {
      throw new SkillError("excluded_path", `${prefix} is excluded for the agent (.novaignore)`);
    }
    const read = await readSkillFolder(place.folder, {
      isExcluded: (path) => deps.projects.isExcluded(workspaceId, `${prefix}/${path}`),
    });
    return {
      ref: skillRef("project", name),
      scope: "project",
      name,
      workspaceId,
      installedAt: null,
      analyzed: analyzeSkill(read, { folderName: name }),
      entries: read.entries,
    };
  };

  const loadRef = (ref: SkillRef, workspaceId: string | null): Promise<LoadedSkill> => {
    const { scope, name } = parseRef(ref);
    if (scope === "builtin") return Promise.resolve(loadBuiltin(name));
    if (scope === "user") return loadUser(name);
    if (workspaceId === null) return Promise.reject(new SkillError("not_found", `project skill "${ref}" needs a project`));
    return loadProject(workspaceId, name);
  };

  /** A user skill as stored at install (no disk read). */
  const userFromRow = (row: InstalledSkillRow): LoadedSkill => ({
    ref: skillRef("user", row.name),
    scope: "user",
    name: row.name,
    workspaceId: null,
    installedAt: row.installedAt,
    analyzed: {
      frontMatter: { name: row.name, description: row.description, version: row.version, allowedTools: row.declared.tools, hosts: row.declared.hosts },
      body: "",
      files: [],
      declared: row.declared,
      warnings: [],
      contentHash: row.contentHash,
      fileCount: row.fileCount,
      totalBytes: row.totalBytes,
      binary: new Set(),
    },
    entries: [],
  });

  /** Folder names under `<root>/.nova/skills` that can be skills (valid names only). */
  const projectNames = async (workspaceId: string): Promise<string[]> => {
    const root = await deps.projects.root(workspaceId);
    let base: string;
    try {
      base = await realpath(join(root, ...PROJECT_SKILLS_DIR.split("/")));
    } catch {
      return [];
    }
    if (!isInside(root, base)) return [];
    const names = await readdir(base).catch(() => [] as string[]);
    return names.filter((name) => SKILL_NAME_PATTERN.test(name)).sort();
  };

  // --- enablement ------------------------------------------------------------------------------

  const isEnabled = (workspaceId: string | null, loaded: LoadedSkill): boolean => {
    if (workspaceId === null) return false;
    const row = deps.repo.enablement(workspaceId, loaded.ref);
    return !!row && row.enabled && row.contentHash === loaded.analyzed.contentHash;
  };

  /** Every skill visible from a workspace; invalid project skills are left out of the list. */
  const listLoaded = async (workspaceId: string | null): Promise<LoadedSkill[]> => {
    const all: LoadedSkill[] = builtins.map((skill) => loadBuiltin(skill.name));
    // The list trusts the stored analysis (no disk read); load() and get() re-check the files.
    for (const row of deps.repo.listInstalled()) all.push(userFromRow(row));
    if (workspaceId !== null) {
      for (const name of await projectNames(workspaceId)) {
        const loaded = await loadProject(workspaceId, name).catch(() => null);
        if (loaded) all.push(loaded);
      }
    }
    return sortByRef(all);
  };

  const enabledLoaded = async (workspaceId: string): Promise<LoadedSkill[]> => {
    const out: LoadedSkill[] = [];
    for (const row of deps.repo.listEnablements(workspaceId)) {
      if (!row.enabled) continue;
      let loaded: LoadedSkill | null;
      try {
        const { scope, name } = parseRef(row.ref);
        const installed = scope === "user" ? deps.repo.getInstalled(name) : null;
        loaded = scope === "user" ? (installed ? userFromRow(installed) : null) : await loadRef(row.ref, workspaceId);
      } catch {
        // Gone, invalid or unreadable: not enabled any more (the manager shows why on `get`).
        loaded = null;
      }
      if (loaded && loaded.analyzed.contentHash === row.contentHash) out.push(loaded);
    }
    return sortByRef(out);
  };

  // --- previews --------------------------------------------------------------------------------

  const prunePreviews = (): void => {
    const time = now();
    for (const [id, preview] of previews) if (preview.expiresAt <= time) previews.delete(id);
    while (previews.size >= MAX_PENDING_PREVIEWS) {
      const oldest = previews.keys().next().value;
      if (oldest === undefined) break;
      previews.delete(oldest);
    }
  };

  const withTransient = async <T>(work: () => Promise<T>, cleanup: () => Promise<unknown>): Promise<T> => {
    try {
      return await work();
    } finally {
      await cleanup().catch(() => undefined);
    }
  };

  const writeEntries = async (folder: string, entries: readonly SkillFileEntry[]): Promise<void> => {
    for (const entry of entries) {
      if (!isCanonicalRelativePath(entry.path) || entry.path === "") throw new SkillError("outside_skill", "invalid file path in skill");
      const target = join(folder, ...entry.path.split("/"));
      if (!isInside(folder, target)) throw new SkillError("outside_skill", "invalid file path in skill");
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, entry.bytes, { flag: "wx" });
    }
  };

  const runtime: SkillsRuntime = {
    async init(): Promise<void> {
      await mkdir(deps.skillsDir, { recursive: true });
      const names = await readdir(deps.skillsDir);
      const rows = new Map(deps.repo.listInstalled().map((row) => [row.installDir, row]));
      for (const name of names) {
        if (name.startsWith(TEMP_PREFIX) || name.startsWith(TRASH_PREFIX)) {
          await rm(join(deps.skillsDir, name), { recursive: true, force: true });
          deps.onRepair?.({ kind: "temp_removed", name });
        } else if (SKILL_NAME_PATTERN.test(name) && !rows.has(name)) {
          await rm(join(deps.skillsDir, name), { recursive: true, force: true });
          deps.onRepair?.({ kind: "orphan_folder_removed", name });
        }
      }
      const present = new Set(names);
      for (const row of rows.values()) {
        if (!present.has(row.installDir)) {
          deps.repo.uninstall(row.name);
          deps.onRepair?.({ kind: "missing_folder_row_removed", name: row.name });
        }
      }
    },

    async list(request: { workspaceId: string | null }): Promise<SkillMeta[]> {
      const all = await listLoaded(request.workspaceId);
      return all.map((loaded) => toMeta(loaded, isEnabled(request.workspaceId, loaded)));
    },

    async get(ref: SkillRef, workspaceId: string | null): Promise<SkillDetail> {
      const loaded = await loadRef(ref, workspaceId);
      return toDetail(loaded, isEnabled(workspaceId, loaded));
    },

    async preview(source: SkillPreviewSource): Promise<SkillPreview> {
      let loaded: LoadedSkill;
      if (source.kind === "folder") {
        const read = await readSkillFolder(source.absolutePath);
        const analyzed = analyzeSkill(read, { folderName: basename(source.absolutePath) });
        const name = analyzed.frontMatter.name;
        loaded = {
          ref: skillRef("user", name),
          scope: "user",
          name,
          workspaceId: null,
          installedAt: null,
          analyzed,
          entries: read.entries,
        };
      } else {
        loaded = await loadProject(source.workspaceId, source.name);
        reviewedProject.set(`${source.workspaceId}\0${source.name}`, loaded.analyzed.contentHash);
      }
      prunePreviews();
      const id = newId();
      previews.set(id, { id, expiresAt: now() + PREVIEW_TTL_MS, loaded, source: source.kind });
      const replaces = source.kind === "folder" && deps.repo.getInstalled(loaded.name) ? loaded.ref : null;
      const enabled = source.kind === "project" ? isEnabled(source.workspaceId, loaded) : false;
      return { ...toDetail(loaded, enabled), previewId: id, replaces };
    },

    async install(previewId: string): Promise<SkillMeta> {
      const preview = previews.get(previewId);
      previews.delete(previewId);
      if (!preview || preview.expiresAt <= now()) {
        throw new SkillError("conflict", "this preview expired or was already used; preview the folder again");
      }
      if (preview.source !== "folder") {
        throw new SkillError("invalid_request", "a project skill is enabled for its project, not installed");
      }
      const { loaded } = preview;
      await mkdir(deps.skillsDir, { recursive: true });
      const temp = join(deps.skillsDir, `${TEMP_PREFIX}${newId()}`);
      const target = userDir(loaded.name);
      const trash = join(deps.skillsDir, `${TRASH_PREFIX}${newId()}`);
      return withTransient(
        async () => {
          await writeEntries(temp, loaded.entries);
          const previous = deps.repo.getInstalled(loaded.name);
          let movedAside = false;
          if (previous) {
            await rename(target, trash).then(
              () => (movedAside = true),
              () => undefined,
            );
          }
          await rename(temp, target);
          try {
            const stored = deps.repo.upsertInstalled({
              name: loaded.name,
              description: loaded.analyzed.frontMatter.description,
              version: loaded.analyzed.frontMatter.version,
              declared: loaded.analyzed.declared,
              contentHash: loaded.analyzed.contentHash,
              fileCount: loaded.analyzed.fileCount,
              totalBytes: loaded.analyzed.totalBytes,
              installDir: loaded.name,
            });
            return toMeta({ ...loaded, installedAt: stored.installedAt }, false);
          } catch (error) {
            // The row is the source of truth: put the previous files back.
            await rm(target, { recursive: true, force: true });
            if (movedAside) await rename(trash, target);
            throw error;
          }
        },
        () => Promise.all([rm(temp, { recursive: true, force: true }), rm(trash, { recursive: true, force: true })]),
      );
    },

    async uninstall(ref: SkillRef): Promise<void> {
      const { scope, name } = parseRef(ref);
      if (scope !== "user") throw new SkillError("invalid_request", "only installed skills can be uninstalled");
      const row = deps.repo.getInstalled(name);
      if (!row) throw new SkillError("not_found", `unknown skill "${ref}"`);
      const folder = join(deps.skillsDir, row.installDir);
      const trash = join(deps.skillsDir, `${TRASH_PREFIX}${newId()}`);
      // Folder aside first (atomic), then the row and every enablement in one transaction.
      const moved = await rename(folder, trash).then(
        () => true,
        () => false,
      );
      try {
        deps.repo.uninstall(name);
      } catch (error) {
        if (moved) await rename(trash, folder).catch(() => undefined);
        throw error;
      }
      await rm(trash, { recursive: true, force: true });
    },

    async setEnabled(workspaceId: string, ref: SkillRef, enabled: boolean): Promise<SkillMeta> {
      const loaded = await loadRef(ref, workspaceId);
      if (enabled && loaded.scope === "project") {
        // Never enabled on trust: the user must have seen this exact content in a preview.
        if (reviewedProject.get(`${workspaceId}\0${loaded.name}`) !== loaded.analyzed.contentHash) {
          throw new SkillError("conflict", "preview_required: the project skill changed or was not previewed; preview it again");
        }
      }
      deps.repo.setEnabled(workspaceId, ref, enabled, enabled ? loaded.analyzed.contentHash : null);
      return toMeta(loaded, enabled);
    },

    async enabled(workspaceId: string): Promise<SkillMeta[]> {
      return (await enabledLoaded(workspaceId)).map((loaded) => toMeta(loaded, true));
    },

    async load(workspaceId: string, ref: SkillRef, path: RelativePath | null): Promise<SkillLoadOutcome> {
      const enabledRow = deps.repo.enablement(workspaceId, ref);
      if (!enabledRow?.enabled) {
        throw new SkillError("not_found", `skill "${ref}" is not enabled for this project; use a ref from the skill index`);
      }
      const loaded = await loadRef(ref, workspaceId);
      if (loaded.analyzed.contentHash !== enabledRow.contentHash) {
        throw new SkillError("not_found", `skill "${ref}" changed since the user enabled it; it must be reviewed again before use`);
      }
      const meta = toMeta(loaded, true);
      const max = SKILL_LIMITS.loadMaxChars;
      if (path === null || path === SKILL_MD) {
        const others = loaded.analyzed.files.filter((file) => file.path !== SKILL_MD);
        const listing =
          others.length === 0
            ? ""
            : `\n\n[Files of this skill (load one with path): ${others
                .slice(0, 100)
                .map((file) => `${file.path} (${file.size} B)`)
                .join(", ")}${others.length > 100 ? `, … ${others.length - 100} more` : ""}]`;
        const body = capHead(loaded.analyzed.body, Math.max(0, max - listing.length));
        return { meta, content: body.text + listing, path: null, truncated: body.truncated };
      }
      if (!isCanonicalRelativePath(path) || path === "") {
        throw new SkillError("outside_skill", `"${path}" is not a path inside the skill (use paths like references/guide.md)`);
      }
      if (loaded.scope === "project" && (await deps.projects.isExcluded(workspaceId, `${PROJECT_SKILLS_DIR}/${loaded.name}/${path}`))) {
        throw new SkillError("excluded_path", `${path} is excluded for the agent`);
      }
      const text = capHead(skillFileText(loaded.analyzed, loaded.entries, path), max);
      return { meta, content: text.text, path, truncated: text.truncated };
    },

    async skillIndex(workspaceId: string): Promise<string | null> {
      return formatSkillIndex(await runtime.enabled(workspaceId));
    },
  };
  return runtime;
}
