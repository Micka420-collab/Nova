// @nova/skills — skills runtime (M8). Owned by lane L3.
//
// - Parses SKILL.md (front matter: name, description, version, allowed-tools, hosts) and lists a
//   skill's files (scripts/, references/, assets/) with SKILL_LIMITS; never executes anything.
// - Sources: builtin (shipped in this package as data, BUILTIN_SKILL_NAMES), user (copied into
//   `<dataDir>/skills/<name>` after `preview` → `install`), project (`<root>/.nova/skills/<name>`,
//   read through the workspace confinement and C8 exclusions; enabling one shows its preview).
// - Enablement per workspace (storage: skills, skill_enablements). Uninstall removes the folder,
//   the row and every enablement in one step (no residue).
// - Backs `ToolDeps.skills` (progressive loading by the `skill` tool) and the `skills.*` IPC group.
import type {
  SkillDetail,
  SkillMeta,
  SkillPreview,
  SkillRef,
  SkillsListRequest,
} from "@nova/shared";
import type { SkillsApi } from "@nova/tools";

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
}
