// L3 — timeline projection of the skills a mission loaded.
// Owned by lane L3 (J2-B lane map). Pure: same events → same view.
import type { HarnessMissionEvent, RelativePath, SkillRef } from "@nova/shared";

export interface SkillsView {
  loaded: { ref: SkillRef; name: string; path: RelativePath | null; chars: number; at: number }[];
}

export type SkillsMissionEvent = Extract<HarnessMissionEvent, { type: "skill.loaded" }>;

export function initialSkillsView(): SkillsView {
  return { loaded: [] };
}

export function reduceSkillsEvent(view: SkillsView, event: SkillsMissionEvent): SkillsView {
  const { ref, name, path, chars, at } = event;
  return { loaded: [...view.loaded, { ref, name, path, chars, at }] };
}
