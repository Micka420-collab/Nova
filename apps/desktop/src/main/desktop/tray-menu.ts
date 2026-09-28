// Tray / menu bar view of Nomi's real state: a pure function of the desktop snapshot (counts read
// from the services), so the icon never shows activity that is not happening.
import type { DesktopSnapshot } from "../services/desktop-service";
import { desktopCopy } from "./copy";

export type TrayStatus = "idle" | "working" | "waiting";

export type TrayAction = { kind: "open" } | { kind: "quit" } | { kind: "open-mission"; missionId: string };

export type TrayMenuEntry =
  | { kind: "label"; label: string }
  | { kind: "separator" }
  | { kind: "action"; label: string; action: TrayAction }
  | { kind: "submenu"; label: string; entries: TrayMenuEntry[] };

export interface TrayView {
  status: TrayStatus;
  tooltip: string;
  /** macOS menu bar text next to the icon ("" = none): the number of active missions. */
  title: string;
  entries: TrayMenuEntry[];
}

const TITLE_MAX_CHARS = 60;

function clipTitle(title: string): string {
  const line = title.replace(/\s+/g, " ").trim();
  return line.length > TITLE_MAX_CHARS ? `${line.slice(0, TITLE_MAX_CHARS - 1)}…` : line;
}

/** Waiting for the user beats working: an approval blocks a mission until someone answers. */
export function trayStatus(snapshot: DesktopSnapshot): TrayStatus {
  const { activity } = snapshot.state;
  if (activity.waitingApprovals > 0) return "waiting";
  if (activity.runningMissions > 0 || activity.runningProcesses > 0) return "working";
  return "idle";
}

export function buildTrayView(snapshot: DesktopSnapshot): TrayView {
  const { activity } = snapshot.state;
  const status = trayStatus(snapshot);
  let statusLabel: string = desktopCopy.status.idle;
  if (status === "waiting") statusLabel = desktopCopy.status.waiting(activity.waitingApprovals);
  else if (activity.runningMissions > 0) statusLabel = desktopCopy.status.working(activity.runningMissions);
  else if (activity.runningProcesses > 0) statusLabel = desktopCopy.status.processes(activity.runningProcesses);
  const missionEntries: TrayMenuEntry[] =
    snapshot.missions.length === 0
      ? [{ kind: "label", label: desktopCopy.noMission }]
      : snapshot.missions.map((mission) => ({
          kind: "action",
          label: mission.state === "waiting_approval" ? `${clipTitle(mission.title)} (${desktopCopy.missionWaiting})` : clipTitle(mission.title),
          action: { kind: "open-mission", missionId: mission.id },
        }));
  return {
    status,
    tooltip: `${desktopCopy.appName} · ${statusLabel}`,
    title: activity.runningMissions > 0 ? String(activity.runningMissions) : "",
    entries: [
      { kind: "label", label: statusLabel },
      { kind: "separator" },
      { kind: "action", label: desktopCopy.open, action: { kind: "open" } },
      { kind: "submenu", label: desktopCopy.missionsMenu(snapshot.missions.length), entries: missionEntries },
      { kind: "separator" },
      { kind: "action", label: desktopCopy.quitApp, action: { kind: "quit" } },
    ],
  };
}
