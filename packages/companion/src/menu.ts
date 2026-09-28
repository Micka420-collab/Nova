// P9 quick-actions menu: entries filtered by real facts only — an entry whose signal is missing is
// hidden, never greyed out. The same entries are palette commands (group « Nomi », principle 8).
import type { Approval, CompanionSourceRef } from "@nova/shared";
import type { NomiAction } from "./act";
import { NOMI_COPY } from "./copy";
import type { ExplainSource } from "./explain";
import type { MissionFacts } from "./facts";

export const NOMI_COMMAND_IDS = [
  "nomi.stopMission",
  "nomi.resumeMission",
  "nomi.openApproval",
  "nomi.explainError",
  "nomi.showChanges",
  "nomi.watchCommand",
  "nomi.quiet",
  "nomi.settings",
] as const;
export type NomiCommandId = (typeof NOMI_COMMAND_IDS)[number];

export interface NomiMenuFacts {
  /** Mission Nomi talks about (`focusMission`). */
  mission: MissionFacts | null;
  pendingApprovals: readonly Approval[];
  /** Most recent unexplained error, already located. */
  recentError: { kind: "source"; source: ExplainSource } | { kind: "ref"; sourceRef: CompanionSourceRef } | null;
  /** A running terminal command not yet watched (P5). */
  unwatchedSessionId: string | null;
  quietUntil: number | null;
  now: number;
}

export type NomiMenuAction = NomiAction | { type: "open_settings" };

export interface NomiMenuEntry {
  id: NomiCommandId;
  label: string;
  action: NomiMenuAction;
}

/** 1 h of quiet mode from the menu (NOMI.md P9). */
export const QUIET_DURATION_MS = 60 * 60_000;

function hasChanges(mission: MissionFacts): boolean {
  return mission.files.length > 0 || mission.tests.length > 0 || mission.commands.length > 0 || mission.checkpoints > 0;
}

/** Entries in P9 order; every entry has a real action behind it. */
export function buildNomiMenu(facts: NomiMenuFacts): NomiMenuEntry[] {
  const menu = NOMI_COPY.menu;
  const entries: NomiMenuEntry[] = [];
  const { mission } = facts;
  if (mission?.state === "running" || mission?.state === "waiting_approval") {
    entries.push({ id: "nomi.stopMission", label: menu.stopMission, action: { type: "stop_mission", missionId: mission.missionId } });
  }
  if (mission?.state === "suspended" && mission.suspendReason === "user") {
    entries.push({ id: "nomi.resumeMission", label: menu.resumeMission, action: { type: "resume_mission", missionId: mission.missionId } });
  }
  const approval = facts.pendingApprovals[0];
  if (approval) {
    entries.push({ id: "nomi.openApproval", label: menu.openApproval, action: { type: "open_approval", approvalId: approval.id } });
  }
  if (facts.recentError) {
    const action: NomiAction =
      facts.recentError.kind === "source"
        ? { type: "explain_source", source: facts.recentError.source }
        : { type: "explain_error", sourceRef: facts.recentError.sourceRef };
    entries.push({ id: "nomi.explainError", label: menu.explainError, action });
  }
  if (mission && hasChanges(mission)) {
    entries.push({ id: "nomi.showChanges", label: menu.showChanges, action: { type: "show_changes", missionId: mission.missionId } });
  }
  if (facts.unwatchedSessionId !== null) {
    entries.push({
      id: "nomi.watchCommand",
      label: menu.watchCommand,
      action: { type: "watch_command", sourceRef: { kind: "terminal", sessionId: facts.unwatchedSessionId } },
    });
  }
  const quiet = facts.quietUntil !== null && facts.quietUntil > facts.now;
  entries.push({
    id: "nomi.quiet",
    label: quiet ? menu.quietOff : menu.quietOn,
    action: { type: "quiet", until: quiet ? null : facts.now + QUIET_DURATION_MS },
  });
  entries.push({ id: "nomi.settings", label: menu.settings, action: { type: "open_settings" } });
  return entries;
}

export interface NomiPaletteCommand {
  id: NomiCommandId;
  group: string;
  title: string;
  keywords: readonly string[];
}

/**
 * Static descriptors for the command palette registry (lane L8). A command is AVAILABLE only when
 * `buildNomiMenu(facts)` contains its id; run it with that entry's action (same code path as the menu).
 */
export const NOMI_PALETTE_COMMANDS: readonly NomiPaletteCommand[] = [
  { id: "nomi.stopMission", group: NOMI_COPY.menu.group, title: NOMI_COPY.menu.stopMission, keywords: ["arrêter", "stop", "mission"] },
  { id: "nomi.resumeMission", group: NOMI_COPY.menu.group, title: NOMI_COPY.menu.resumeMission, keywords: ["reprendre", "continuer", "mission"] },
  { id: "nomi.openApproval", group: NOMI_COPY.menu.group, title: NOMI_COPY.menu.openApproval, keywords: ["approbation", "autoriser", "permission"] },
  { id: "nomi.explainError", group: NOMI_COPY.menu.group, title: NOMI_COPY.menu.explainError, keywords: ["erreur", "expliquer", "échec"] },
  { id: "nomi.showChanges", group: NOMI_COPY.menu.group, title: NOMI_COPY.menu.showChanges, keywords: ["changements", "diff", "résumé"] },
  { id: "nomi.watchCommand", group: NOMI_COPY.menu.group, title: NOMI_COPY.menu.watchCommand, keywords: ["surveiller", "tests", "commande"] },
  { id: "nomi.quiet", group: NOMI_COPY.menu.group, title: NOMI_COPY.menu.quietOn, keywords: ["discret", "silence", "notifications"] },
  { id: "nomi.settings", group: NOMI_COPY.menu.group, title: NOMI_COPY.menu.settings, keywords: ["compagnon", "réglages", "nomi"] },
];
