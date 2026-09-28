// Coded failures of the skills runtime. Messages are English, secret-free and never quote file
// content; main maps the code to an IPC error and the `skill` tool maps it to a tool error.

/** Why a skill folder is refused (shown to the user before install, and to the model on load). */
export type SkillInvalidReason =
  | "missing_skill_md"
  | "missing_front_matter"
  | "invalid_front_matter"
  | "missing_name"
  | "invalid_name"
  | "missing_description"
  | "description_too_long"
  | "skill_md_too_large"
  | "too_many_files"
  | "too_large"
  | "too_deep"
  | "link_outside"
  | "unsupported_entry"
  | "not_a_folder";

export type SkillErrorCode =
  /** Unknown skill, not enabled for the project, or a file the skill does not have. */
  | "not_found"
  /** The folder is not a valid skill (`reason` says why). */
  | "invalid_skill"
  /** A request that cannot apply (uninstalling a builtin, installing a project skill…). */
  | "invalid_request"
  /** The content changed since the user saw it (preview again), or an expired preview. */
  | "conflict"
  /** A path excluded by C8 (sensitive name or `.novaignore`). */
  | "excluded_path"
  /** A path that is not canonical or leaves the skill folder. */
  | "outside_skill"
  | "binary";

export class SkillError extends Error {
  readonly code: SkillErrorCode;
  readonly reason: SkillInvalidReason | null;
  /** Path or name concerned (relative to the skill), when meaningful. */
  readonly subject: string | null;
  constructor(code: SkillErrorCode, message: string, options: { reason?: SkillInvalidReason; subject?: string | null } = {}) {
    super(message);
    this.name = "SkillError";
    this.code = code;
    this.reason = options.reason ?? null;
    this.subject = options.subject ?? null;
  }
}

export function invalidSkill(reason: SkillInvalidReason, message: string, subject: string | null = null): SkillError {
  return new SkillError("invalid_skill", message, { reason, subject });
}

export function isSkillError(error: unknown): error is SkillError {
  return error instanceof SkillError;
}
