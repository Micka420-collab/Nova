// L5 — timeline projection of the sub-missions of a parent mission.
// Owned by lane L5 (J2-B lane map). Pure: same events → same view.
import type { HarnessMissionEvent, MissionLink, MissionState } from "@nova/shared";

export interface SubMissionView {
  link: MissionLink;
  title: string;
  /** Last reported state of the child; null until the first update. */
  childState: MissionState | null;
}

export interface SubmissionsView {
  children: SubMissionView[];
}

export type SubmissionsMissionEvent = Extract<HarnessMissionEvent, { type: "submission.started" | "submission.updated" }>;

export function initialSubmissionsView(): SubmissionsView {
  return { children: [] };
}

export function reduceSubmissionsEvent(view: SubmissionsView, event: SubmissionsMissionEvent): SubmissionsView {
  const id = event.link.childMissionId;
  switch (event.type) {
    case "submission.started":
      if (view.children.some((child) => child.link.childMissionId === id)) return view;
      return { children: [...view.children, { link: event.link, title: event.title, childState: null }] };
    case "submission.updated":
      return {
        children: view.children.map((child) =>
          child.link.childMissionId === id ? { ...child, link: event.link, childState: event.childState } : child,
        ),
      };
  }
}
