// Companion state derived only from real facts: network, provider connection, stream phase,
// outcome, and — with the atelier — the focused mission, its pending approvals and the tool that
// really runs (NOMI.md §6 priorities). Pure: same facts, same pose, same words.
import { NOMI_COPY, WORKING_ACTIVITIES, type MissionFacts, type NomiActivity } from "@nova/companion";
import type { ProviderConnectionView, StreamPhase } from "@nova/shared";
import type { NomiState } from "@nova/ui";
import { fr } from "../copy/fr";
import { formatRelative } from "../lib/format";

export type OutcomeKind = "success" | "error" | "stopped";

export interface LastOutcome {
  kind: OutcomeKind;
  at: number;
}

export interface NomiInput {
  online: boolean;
  /** `null` while the connection has not been read yet. */
  connection: ProviderConnectionView | null;
  activeStreamPhase: StreamPhase | null;
  lastOutcome: LastOutcome | null;
  /** Title of the conversation of `lastOutcome` when that conversation is not on screen. */
  outcomeElsewhere?: string | null;
  /** Mission Nomi talks about (`focusMission` of the companion facts). */
  mission?: MissionFacts | null;
  /** Tool activity of that mission (`currentActivity`). */
  activity?: NomiActivity;
  /** Pending approvals across missions. */
  approvalsPending?: number;
  /** Last terminal mission event (succeeded → success, failed → error, cancelled → stopped). */
  missionOutcome?: (LastOutcome & { title: string | null }) | null;
  /** Quiet mode end, null when off. */
  quietUntil?: number | null;
  now: number;
}

export interface NomiView {
  state: NomiState;
  label: string;
  detail: string;
  /** Accessory-driving activity; `none` outside thinking/working. */
  activity: NomiActivity;
  /** Flavor of `waiting`: an approval to answer, or a suspended mission. */
  waiting: "active" | "suspended";
  quiet: boolean;
}

/** How long a finished generation keeps Nomi in its success/error/stopped pose. */
export const OUTCOME_WINDOW_MS = 4000;

function connectionDetail(connection: ProviderConnectionView, now: number): string {
  if (connection.state === "valid" && connection.lastCheckedAt !== null) {
    return fr.nomi.verified(formatRelative(connection.lastCheckedAt, now));
  }
  return connection.state === "error" ? fr.nomi.checkFailed : fr.nomi.unverified;
}

function isRecent(outcome: LastOutcome | null | undefined, now: number): outcome is LastOutcome {
  return outcome !== null && outcome !== undefined && now - outcome.at >= 0 && now - outcome.at < OUTCOME_WINDOW_MS;
}

type Pose = Pick<NomiView, "state" | "label" | "detail"> & Partial<Pick<NomiView, "activity" | "waiting">>;

function pose(view: Pose, quiet = false): NomiView {
  return { activity: "none", waiting: "active", ...view, quiet };
}

export function deriveNomiState({
  online,
  connection,
  activeStreamPhase,
  lastOutcome,
  outcomeElsewhere = null,
  mission = null,
  activity = "none",
  approvalsPending = 0,
  missionOutcome = null,
  quietUntil = null,
  now,
}: NomiInput): NomiView {
  if (connection === null) return pose({ state: "offline", label: fr.nomi.starting, detail: fr.nomi.startingDetail });
  if (connection.state === "absent") return pose({ state: "offline", label: fr.nomi.noKey, detail: fr.nomi.noKeyDetail });
  if (connection.state === "invalid") {
    return pose({ state: "error", label: fr.nomi.invalidKey, detail: fr.nomi.invalidKeyDetail });
  }
  if (!online) return pose({ state: "offline", label: fr.nomi.offline, detail: fr.nomi.offlineDetail });
  const step = mission ? NOMI_COPY.state.missionStep(mission.title, mission.step, mission.steps) : null;
  if (approvalsPending > 0 || mission?.state === "waiting_approval") {
    const count = Math.max(approvalsPending, mission?.pendingApprovals.length ?? 0);
    const detail = count > 0 ? NOMI_COPY.state.approvalsPending(count) : (step ?? "");
    return pose({ state: "waiting", label: NOMI_COPY.state.waitingApproval, detail });
  }
  if (activeStreamPhase === "waiting") {
    return pose({ state: "thinking", label: fr.nomi.thinking, detail: fr.nomi.waitingDetail });
  }
  if (activeStreamPhase === "reasoning") {
    return pose({ state: "thinking", label: fr.nomi.thinking, detail: fr.nomi.reasoningDetail });
  }
  if (activeStreamPhase === "writing") return pose({ state: "working", label: fr.nomi.working, detail: fr.nomi.writingDetail });
  if (mission?.state === "running" && step !== null) {
    const working = WORKING_ACTIVITIES.has(activity);
    return pose({
      state: working ? "working" : "thinking",
      label: working ? NOMI_COPY.state.missionWorking : fr.nomi.thinking,
      detail: step,
      activity,
    });
  }
  const detail = connectionDetail(connection, now);
  // The most recent terminal fact wins: a chat answer or a mission end.
  const missionRecent = isRecent(missionOutcome, now) ? missionOutcome : null;
  const chatRecent = isRecent(lastOutcome, now) ? lastOutcome : null;
  if (missionRecent && (!chatRecent || missionRecent.at >= chatRecent.at)) {
    const title = missionRecent.title;
    if (missionRecent.kind === "success") return pose({ state: "success", label: NOMI_COPY.state.missionDone, detail: title ?? detail });
    if (missionRecent.kind === "error") return pose({ state: "error", label: NOMI_COPY.state.missionFailed, detail: title ?? detail });
    return pose({ state: "idle", label: NOMI_COPY.state.missionStopped, detail: title ?? detail });
  }
  if (chatRecent?.kind === "success") return pose({ state: "success", label: fr.nomi.success, detail });
  if (chatRecent?.kind === "error") {
    const errorDetail = outcomeElsewhere === null ? fr.nomi.errorDetail : fr.nomi.errorElsewhere(outcomeElsewhere);
    return pose({ state: "error", label: fr.nomi.error, detail: errorDetail });
  }
  if (chatRecent?.kind === "stopped") return pose({ state: "idle", label: fr.nomi.stopped, detail });
  if (mission?.state === "suspended") {
    const label = mission.suspendReason === "budget" || mission.suspendReason === "daily_budget"
      ? NOMI_COPY.state.suspendedBudget
      : NOMI_COPY.state.suspended;
    return pose({ state: "waiting", label, detail: step ?? detail, waiting: "suspended" });
  }
  if (quietUntil !== null && quietUntil > now) {
    return pose({ state: "idle", label: NOMI_COPY.state.quiet(quietUntil), detail }, true);
  }
  return pose({ state: "idle", label: fr.nomi.idle, detail });
}
