// L3 — card body of a `skill` tool result. Owned by L3.
import type { ToolDisplay } from "@nova/shared";
import { skillsCopy } from "../../../copy/fr-skills";
import { formatInteger } from "../../../lib/format";

const copy = skillsCopy.display;

export function SkillDisplay({ display }: { display: Extract<ToolDisplay, { kind: "skill" }> }) {
  return (
    <p className="nova-tool__fact">
      {copy.loaded(display.name)}
      {display.path ? ` · ${copy.file(display.path)}` : ""} · {copy.size(formatInteger(display.chars))}
    </p>
  );
}
