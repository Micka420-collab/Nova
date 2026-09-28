// L3 — French explanation of a skills.* refusal. Main encodes the skill-specific cases in a stable
// message prefix (skills-service.ts); anything else falls back to the generic IPC copy.
import { NovaIpcError, type SkillMeta } from "@nova/shared";
import { BUILTIN_SKILL_LABELS, SKILL_INVALID_COPY, skillsCopy } from "../../copy/fr-skills";
import { describeUiError, toUiError } from "../../lib/errors";

const copy = skillsCopy.preview;

export function skillErrorText(error: unknown): string {
  if (error instanceof NovaIpcError) {
    const message = error.message;
    if (message.startsWith("skill_invalid:")) {
      const reason = message.slice("skill_invalid:".length).split(":")[0] ?? "";
      return SKILL_INVALID_COPY[reason] ?? copy.unknownInvalid;
    }
    if (message === "skill_preview_required") return copy.previewRequired;
    if (message === "skill_preview_expired") return copy.expired;
    if (message === "skill_excluded") return copy.excluded;
  }
  return describeUiError(toUiError(error)).title;
}

/** French name of a shipped skill; the declared name otherwise. */
export function skillLabel(meta: Pick<SkillMeta, "scope" | "name">): string {
  if (meta.scope === "builtin" && meta.name in BUILTIN_SKILL_LABELS) {
    return BUILTIN_SKILL_LABELS[meta.name as keyof typeof BUILTIN_SKILL_LABELS];
  }
  return meta.name;
}
