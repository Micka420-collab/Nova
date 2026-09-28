// @nova/skills — skills runtime (M8). Owned by lane L3.
//
// - Parses SKILL.md (front matter: name, description, version, allowed-tools, hosts) and lists a
//   skill's files (scripts/, references/, assets/) with SKILL_LIMITS; never executes anything.
// - Sources: builtin (shipped in this package as data, BUILTIN_SKILL_NAMES), user (copied into
//   `<dataDir>/skills/<name>` after `preview` → `install`), project (`<root>/.nova/skills/<name>`,
//   read through the workspace confinement and C8 exclusions; enabling one requires a preview of
//   its current content).
// - Enablement per workspace (storage: skills, skill_enablements) records the content hash the
//   user saw: changed content is not enabled until reviewed again. Uninstall removes the folder,
//   the row and every enablement in one step (no residue).
// - Backs `ToolDeps.skills` (progressive loading by the `skill` tool), the `skills.*` IPC group
//   and the mission skill index (`skillIndex`, bounded and fenced as data).
import type {
  SkillDetail,
  SkillMeta,
  SkillPreview,
  SkillRef,
  SkillsListRequest,
} from "@nova/shared";
import type { SkillsApi } from "@nova/tools";
import type { SkillIndex } from "./skill-index";

export type SkillPreviewSource =
  /** A folder the user picked in main's native dialog (absolute path never leaves main). */
  | { kind: "folder"; absolutePath: string }
  | { kind: "project"; workspaceId: string; name: string };

export interface SkillsRuntime extends SkillsApi {
  list(request: SkillsListRequest): Promise<SkillMeta[]>;
  get(ref: SkillRef, workspaceId: string | null): Promise<SkillDetail>;
  preview(source: SkillPreviewSource): Promise<SkillPreview>;
  install(previewId: string): Promise<SkillMeta>;
  uninstall(ref: SkillRef): Promise<void>;
  setEnabled(workspaceId: string, ref: SkillRef, enabled: boolean): Promise<SkillMeta>;
  /** Removes crash leftovers and folder/row mismatches under the skills folder. Idempotent. */
  init(): Promise<void>;
  /** Index of the enabled skills for a mission's system prompt; null = none enabled. */
  skillIndex(workspaceId: string): Promise<SkillIndex | null>;
}

export { BUILTIN_SKILLS, type BuiltinSkill } from "./builtin";
export { SkillError, isSkillError, type SkillErrorCode, type SkillInvalidReason } from "./errors";
export { parseSkillMd, type ParsedSkillMd, type SkillFrontMatter } from "./front-matter";
export {
  MAX_PENDING_PREVIEWS,
  PREVIEW_TTL_MS,
  PROJECT_SKILLS_DIR,
  createSkillsRuntime,
  type InstalledSkillRow,
  type ProjectSkillsAccess,
  type SkillsRepoPort,
  type SkillsRuntimeDeps,
} from "./runtime";
export { SKILL_MD, analyzeSkill, readSkillFolder, type AnalyzedSkill, type SkillFileEntry } from "./scan";
export { SKILL_INDEX_MAX_CHARS, SKILL_INDEX_MAX_SKILLS, formatSkillIndex, type SkillIndex } from "./skill-index";
