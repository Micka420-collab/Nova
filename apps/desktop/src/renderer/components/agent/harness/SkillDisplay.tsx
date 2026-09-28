// L3 — card body of a `skill` tool result. Owned by L3.
import type { SkillScope, ToolDisplay } from "@nova/shared";
import { SKILL_SCOPE_LABELS, skillsCopy } from "../../../copy/fr-skills";
import { formatInteger } from "../../../lib/format";
import { skillLabel } from "../../skills/skill-errors";

const copy = skillsCopy.display;

export function SkillDisplay({ display }: { display: Extract<ToolDisplay, { kind: "skill" }> }) {
  const scope = display.ref.slice(0, display.ref.indexOf(":")) as SkillScope;
  return (
    <p className="nova-tool__fact">
      {copy.loaded(skillLabel({ scope, name: display.name }))} · {SKILL_SCOPE_LABELS[scope]}
      {display.path ? ` · ${copy.file(display.path)}` : ""} · {copy.size(formatInteger(display.chars))}
    </p>
  );
}
