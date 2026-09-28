// The native question asked before quitting while something runs. Pure: built from the desktop
// snapshot; null when nothing would stop (then NOVA quits without asking).
import type { DesktopSource } from "@nova/shared";
import type { DesktopSnapshot } from "../services/desktop-service";
import { desktopCopy } from "./copy";

export interface QuitWarning {
  title: string;
  message: string;
  detail: string;
  /** Index 0 cancels (default, Escape); index 1 quits. */
  buttons: [string, string];
}

export const QUIT_CANCEL = 0;
export const QUIT_CONFIRM = 1;
const LISTED_TITLES = 3;

function formatNext(at: number, now: number): string {
  const date = new Date(at);
  const time = new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit" }).format(date);
  if (new Date(now).toDateString() === date.toDateString()) return `à ${time}`;
  const day = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "long" }).format(date);
  return `le ${day} à ${time}`;
}

/**
 * What quitting would interrupt: missions, their approvals and processes, schedules. The user's own
 * terminals are not asked about: an open shell is almost always idle at its prompt (NOVA cannot tell
 * whether a program runs in it), and a question on every quit with a terminal open teaches to click
 * through it. Their process trees are still killed at quit (pty-host), never left behind.
 */
const QUIT_SOURCES: ReadonlySet<DesktopSource> = new Set(["missions", "approvals", "processes", "schedules"]);

export function buildQuitWarning(snapshot: DesktopSnapshot, now: number = Date.now()): QuitWarning | null {
  const { activity } = snapshot.state;
  const unreadable = snapshot.state.unreadable.filter((source) => QUIT_SOURCES.has(source));
  const running = activity.runningMissions + activity.waitingApprovals + activity.runningProcesses + activity.activeSchedules;
  if (running === 0 && unreadable.length === 0) return null;
  const copy = desktopCopy.quit;
  const lines: string[] = [];
  if (activity.runningMissions > 0) {
    const shown = snapshot.missions.slice(0, LISTED_TITLES).map((mission) => `« ${mission.title} »`);
    const more = snapshot.missions.length - shown.length;
    lines.push(copy.missions(activity.runningMissions, more > 0 ? `${shown.join(", ")}…` : shown.join(", ")));
  }
  if (activity.waitingApprovals > 0) lines.push(copy.approvals(activity.waitingApprovals));
  if (activity.runningProcesses > 0) lines.push(copy.processes(activity.runningProcesses));
  if (activity.activeSchedules > 0) {
    const next = activity.nextScheduledAt === null ? null : formatNext(activity.nextScheduledAt, now);
    lines.push(copy.schedules(activity.activeSchedules, next));
  }
  const detail = [copy.intro, ...lines.map((line) => `• ${line}`)];
  if (unreadable.length > 0) detail.push("", copy.unreadable);
  return { title: copy.title, message: copy.message, detail: detail.join("\n"), buttons: [copy.cancel, copy.confirm] };
}
