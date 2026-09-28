// J2-B L3 (M8): skills. A skill is a folder with a SKILL.md (YAML front matter `name`,
// `description`, optional `version`, `allowed-tools`, `hosts`) plus optional `scripts/`,
// `references/` and `assets/`. Sources:
// - builtin: shipped with NOVA (read-only, BUILTIN_SKILL_NAMES);
// - user: installed into NOVA's data dir after a preview (content + declared permissions);
// - project: discovered in `<workspace>/.nova/skills/<name>/SKILL.md` (never auto-enabled).
// Skills are enabled per project. The model sees only name + description until it calls the
// `skill` tool (progressive loading). A skill's declared permissions are information for the user,
// never a grant: its scripts run through run_command under the same permission engine.
// Uninstall removes the folder, the row and every enablement (no residue).
import { z } from "zod";
import { EntityIdSchema } from "./ids";
import type { RelativePath } from "./paths";

export type SkillScope = "builtin" | "user" | "project";

/** Agent Skills naming: lowercase letters, digits and single hyphens, ≤ 64 characters. */
export const SKILL_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,63}$/;
export const SkillNameSchema = z.string().regex(SKILL_NAME_PATTERN, "nom de skill invalide");

/** Stable reference: `<scope>:<name>` (project refs are relative to a workspace). */
export type SkillRef = `${SkillScope}:${string}`;
export const SkillRefSchema = z
  .string()
  .max(80)
  .regex(/^(builtin|user|project):[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,63}$/, "référence de skill invalide")
  .transform((value) => value as SkillRef);

export function skillRef(scope: SkillScope, name: string): SkillRef {
  return `${scope}:${name}`;
}

/** The three skills shipped with NOVA (French UI names in the renderer copy). */
export const BUILTIN_SKILL_NAMES = ["comprendre-un-depot", "ecrire-des-tests-utiles", "preparer-une-release"] as const;
export type BuiltinSkillName = (typeof BUILTIN_SKILL_NAMES)[number];

export const SKILL_LIMITS = {
  /** SKILL.md size accepted (characters). */
  skillMdMaxChars: 50_000,
  /** Description shown to the model in the skill index. */
  descriptionMaxChars: 1_024,
  maxFiles: 200,
  maxTotalBytes: 5_000_000,
  /** Characters the `skill` tool returns per call (references are loaded one by one). */
  loadMaxChars: 30_000,
} as const;

/** What a skill says it needs (from its front matter and its files). Informational, never a grant. */
export interface SkillDeclaredPermissions {
  /** Tool names listed in `allowed-tools` (unknown names are kept and flagged). */
  tools: string[];
  hosts: string[];
  /** Scripts shipped by the skill (they only run through run_command, approved like any command). */
  scripts: RelativePath[];
}

export type SkillWarningCode =
  | "unknown_tool"
  | "network_hosts"
  | "has_scripts"
  | "binary_files"
  | "too_large"
  | "name_mismatch"
  | "secret_detected";

export interface SkillWarning {
  code: SkillWarningCode;
  /** Path or tool concerned; null = the whole skill. */
  subject: string | null;
}

export interface SkillMeta {
  ref: SkillRef;
  name: string;
  description: string;
  version: string | null;
  scope: SkillScope;
  /** Project skills only. */
  workspaceId: string | null;
  /** Enabled for the workspace of the request (false when the request has no workspace). */
  enabled: boolean;
  declared: SkillDeclaredPermissions;
  /** sha256 of the skill's files (changes after an update on disk). */
  contentHash: string;
  fileCount: number;
  totalBytes: number;
  /** null for builtin and project skills. */
  installedAt: number | null;
}

export interface SkillFileInfo {
  path: RelativePath;
  size: number;
  kind: "skill_md" | "script" | "reference" | "asset" | "other";
}

export interface SkillDetail {
  meta: SkillMeta;
  /** SKILL.md body (front matter removed), capped at SKILL_LIMITS.skillMdMaxChars. */
  content: string;
  files: SkillFileInfo[];
  warnings: SkillWarning[];
}

/** What the user sees BEFORE installing: the full SKILL.md, its files and declared permissions. */
export interface SkillPreview extends SkillDetail {
  /** Single-use token for `skills.install` (the folder was copied to a staging area). */
  previewId: string;
  /** An installed skill of the same name would be replaced. */
  replaces: SkillRef | null;
}

export const SkillsListRequestSchema = z.object({ workspaceId: EntityIdSchema.nullable() });
export const SkillGetRequestSchema = z.object({ ref: SkillRefSchema, workspaceId: EntityIdSchema.nullable() });
/** `picker`: main opens a folder picker (the renderer never sends absolute paths). */
export const SkillPreviewRequestSchema = z.object({
  source: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("picker") }),
    z.object({ kind: z.literal("project"), workspaceId: EntityIdSchema, name: SkillNameSchema }),
  ]),
});
export const SkillInstallRequestSchema = z.object({ previewId: EntityIdSchema });
export const SkillUninstallRequestSchema = z.object({ ref: SkillRefSchema });
export const SkillSetEnabledRequestSchema = z.object({
  workspaceId: EntityIdSchema,
  ref: SkillRefSchema,
  enabled: z.boolean(),
});

export type SkillsListRequest = z.infer<typeof SkillsListRequestSchema>;
export type SkillGetRequest = z.infer<typeof SkillGetRequestSchema>;
export type SkillPreviewRequest = z.infer<typeof SkillPreviewRequestSchema>;
export type SkillInstallRequest = z.infer<typeof SkillInstallRequestSchema>;
export type SkillUninstallRequest = z.infer<typeof SkillUninstallRequestSchema>;
export type SkillSetEnabledRequest = z.infer<typeof SkillSetEnabledRequestSchema>;
