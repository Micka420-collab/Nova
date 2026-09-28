// L3 — state of the skills manager (pure reducer, used with useReducer by SkillsManager; the store
// needs no global slice: skills are read from main each time the manager shows).
import type { SkillMeta, SkillRef, SkillScope } from "@nova/shared";

export type SkillsListState =
  | { status: "loading" }
  | { status: "ready"; skills: SkillMeta[] }
  /** main answers `unavailable`: the manager shows no control at all. */
  | { status: "unavailable" }
  | { status: "error"; message: string };

export type SkillsListAction =
  | { type: "loading" }
  | { type: "loaded"; skills: SkillMeta[] }
  | { type: "unavailable" }
  | { type: "failed"; message: string }
  /** A skill main returned after install or (de)activation. */
  | { type: "upsert"; skill: SkillMeta }
  | { type: "removed"; ref: SkillRef };

const byRef = (a: SkillMeta, b: SkillMeta) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0);

export function reduceSkillsList(state: SkillsListState, action: SkillsListAction): SkillsListState {
  switch (action.type) {
    case "loading":
      return { status: "loading" };
    case "loaded":
      return { status: "ready", skills: [...action.skills].sort(byRef) };
    case "unavailable":
      return { status: "unavailable" };
    case "failed":
      return { status: "error", message: action.message };
    case "upsert": {
      if (state.status !== "ready") return state;
      const others = state.skills.filter((skill) => skill.ref !== action.skill.ref);
      return { status: "ready", skills: [...others, action.skill].sort(byRef) };
    }
    case "removed":
      if (state.status !== "ready") return state;
      return { status: "ready", skills: state.skills.filter((skill) => skill.ref !== action.ref) };
  }
}

export function skillsOfScope(state: SkillsListState, scope: SkillScope): SkillMeta[] {
  return state.status === "ready" ? state.skills.filter((skill) => skill.scope === scope) : [];
}
