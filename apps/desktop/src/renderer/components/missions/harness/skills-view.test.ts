import { describe, expect, it } from "vitest";
import { initialSkillsView, reduceSkillsEvent, type SkillsMissionEvent } from "./skills-view";

const event = (seq: number, path: string | null): SkillsMissionEvent => ({
  id: `00000000-0000-4000-8000-00000000000${seq}`,
  missionId: "00000000-0000-4000-8000-00000000a001",
  seq,
  at: seq * 10,
  type: "skill.loaded",
  ref: "user:notes",
  name: "notes",
  path,
  chars: 120,
});

describe("skills view", () => {
  it("keeps every load in journal order (SKILL.md, then one file at a time)", () => {
    const events = [event(1, null), event(2, "references/format.md")];
    const view = events.reduce(reduceSkillsEvent, initialSkillsView());
    expect(view.loaded).toEqual([
      { ref: "user:notes", name: "notes", path: null, chars: 120, at: 10 },
      { ref: "user:notes", name: "notes", path: "references/format.md", chars: 120, at: 20 },
    ]);
    // Pure: replaying the same events gives the same view.
    expect(events.reduce(reduceSkillsEvent, initialSkillsView())).toEqual(view);
  });
});
