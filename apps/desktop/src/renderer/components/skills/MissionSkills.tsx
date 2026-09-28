// L3 — skills a mission loaded (from its journal: `skill.loaded` events, via the skills slice of
// the mission view). Renders nothing when the mission loaded none.
import type { SkillScope } from "@nova/shared";
import { skillsCopy } from "../../copy/fr-skills";
import type { SkillsView } from "../missions/harness/skills-view";
import { skillLabel } from "./skill-errors";

const copy = skillsCopy.mission;

export function MissionSkills({ view }: { view: SkillsView }) {
  if (view.loaded.length === 0) return null;
  return (
    <section aria-label={copy.heading}>
      <h3 className="nova-skills__subheading">{copy.heading}</h3>
      <ul className="nova-mission-skills">
        {view.loaded.map((item, index) => {
          const scope = item.ref.slice(0, item.ref.indexOf(":")) as SkillScope;
          return <li key={`${item.ref}:${item.path ?? ""}:${index}`}>{copy.loadedAt(skillLabel({ scope, name: item.name }), item.path)}</li>;
        })}
      </ul>
    </section>
  );
}
