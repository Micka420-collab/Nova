import { describe, expect, it } from "vitest";
import type { MissionLink } from "@nova/shared";
import { initialSubmissionsView, reduceSubmissionsEvent, type SubmissionsMissionEvent } from "./submissions-view";

const link = (child: string, over: Partial<MissionLink> = {}): MissionLink => ({
  childMissionId: child,
  parentMissionId: "parent",
  kind: "submission",
  forkSeq: null,
  depth: 1,
  reservedUsd: 0.1,
  worktree: child,
  integration: null,
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

let seq = 0;
const started = (child: string, title: string): SubmissionsMissionEvent => ({ id: `e${(seq += 1)}`, missionId: "parent", seq, at: seq, type: "submission.started", link: link(child), title });
const updated = (child: string, over: Partial<MissionLink>, childState: "succeeded" | "failed" | "running" = "succeeded"): SubmissionsMissionEvent => ({
  id: `e${(seq += 1)}`,
  missionId: "parent",
  seq,
  at: seq,
  type: "submission.updated",
  link: link(child, over),
  childState,
});

describe("submissions view", () => {
  it("lists children in start order and follows their integration", () => {
    let view = initialSubmissionsView();
    view = reduceSubmissionsEvent(view, started("a", "Explorer"));
    view = reduceSubmissionsEvent(view, started("b", "Écrire"));
    view = reduceSubmissionsEvent(view, updated("b", { integration: "pending" }));
    view = reduceSubmissionsEvent(view, updated("b", { integration: "integrated", worktree: null }));
    expect(view.children.map((child) => [child.title, child.childState, child.link.integration])).toEqual([
      ["Explorer", null, null],
      ["Écrire", "succeeded", "integrated"],
    ]);
  });

  it("is idempotent on a replayed start and ignores updates for unknown children", () => {
    let view = reduceSubmissionsEvent(initialSubmissionsView(), started("a", "Explorer"));
    const again = reduceSubmissionsEvent(view, started("a", "Explorer"));
    expect(again).toBe(view);
    view = reduceSubmissionsEvent(view, updated("zzz", { integration: "pending" }));
    expect(view.children.map((child) => child.link.childMissionId)).toEqual(["a"]);
  });
});
