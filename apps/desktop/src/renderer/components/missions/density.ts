// J2-B L7: how much of a mission the timeline shows (`settings.display.density`). A pure filter of
// the projected timeline: it changes what is displayed, never what the mission may do, and it
// counts what it hides so the card can say so (« n étapes masquées · Tout afficher »).
// Whatever the density, a decision the user owes (a pending approval, a call waiting for it) and
// the reason a mission stopped stay visible: hiding them would leave an action without outcome.
import type { DetailDensity } from "@nova/shared";
import { toolCategory, type TimelineItem, type ToolItem } from "./timeline";

export interface DensityView {
  items: TimelineItem[];
  /** Items left out by the density (0 for « Tout »). */
  hidden: number;
}

/** Owed by the user or explaining a stop: shown at every density. */
function alwaysShown(item: TimelineItem): boolean {
  switch (item.kind) {
    case "approval":
      return item.approval.status === "pending";
    case "tool":
      return item.state === "waiting";
    case "notice":
      return item.notice.type === "suspended";
    case "message":
      return false;
  }
}

/** Successful look-ups (reading, listing, searching): the routine of a mission, not a key step. */
function isRoutineLookup(item: ToolItem): boolean {
  const category = toolCategory(item.call.name);
  return item.state === "succeeded" && (category === "read" || category === "search");
}

function keyStep(item: TimelineItem): boolean {
  switch (item.kind) {
    case "tool":
      return !isRoutineLookup(item);
    case "message":
      // A model turn that only called tools has no text: nothing to show.
      return !item.complete || item.text.trim() !== "";
    case "approval":
    case "notice":
      return true;
  }
}

/** The mission's answer so far: its last message with text. */
function lastAnswerIndex(items: readonly TimelineItem[]): number {
  return items.findLastIndex((item) => item.kind === "message" && item.text.trim() !== "");
}

function resultItem(item: TimelineItem, index: number, answer: number): boolean {
  if (index === answer) return true;
  if (item.kind !== "notice") return false;
  return item.notice.type === "proof" || item.notice.type === "review";
}

export function applyDensity(items: readonly TimelineItem[], density: DetailDensity): DensityView {
  if (density === "all") return { items: [...items], hidden: 0 };
  const answer = density === "result" ? lastAnswerIndex(items) : -1;
  const kept = items.filter(
    (item, index) => alwaysShown(item) || (density === "key_steps" ? keyStep(item) : resultItem(item, index, answer)),
  );
  // Empty tool-only turns are not steps: they are not counted as hidden either.
  const countable = items.filter((item) => !(item.kind === "message" && item.complete && item.text.trim() === "")).length;
  return { items: kept, hidden: Math.max(0, countable - kept.length) };
}
