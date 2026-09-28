// Nomi's actions (P1, P3, P4, P5, P9): each maps to an EXISTING API (missions.stop/resume/get,
// approvals.list…) with the same permissions — Nomi has no rights of its own — and every action
// ends in a visible ActionOutcome, including "nothing to do" and failures. `performNomiAction`
// never throws.
import {
  isTerminalMissionState,
  NovaIpcError,
  type Approval,
  type ApprovalsListRequest,
  type CompanionAction,
  type CompanionSourceRef,
  type Mission,
  type MissionDetail,
  type MissionEvent,
  type MissionGetRequest,
  type MissionIdRequest,
} from "@nova/shared";
import { missionFactsFromEvents, summarizeMissionChanges, type ChangeLine } from "./changes";
import { NOMI_COPY } from "./copy";
import { explainLocally, type ExplainSource, type Explanation } from "./explain";
import { shortCommand } from "./format";

export type ActionOutcome =
  | {
      ok: true;
      message: string;
      /** Facts to show under the message (P4), each opening its proof. */
      lines?: ChangeLine[];
      explanation?: Explanation;
      /** View the renderer opens (approval card, mission, diff, terminal…); null = none. */
      navigate: CompanionAction | null;
    }
  | { ok: false; reason: "nothing_to_do" | "not_found" | "unavailable" | "failed"; message: string };

/** Everything Nomi can do from its menu, the palette or a suggestion. */
export type NomiAction =
  | CompanionAction
  | { type: "resume_mission"; missionId: string }
  /** Local explanation of an error already normalized by the caller (e.g. a chat failure). */
  | { type: "explain_source"; source: ExplainSource }
  | { type: "quiet"; until: number | null };

export interface NomiActionPorts {
  missions: {
    get(req: MissionGetRequest): Promise<MissionDetail>;
    stop(req: MissionIdRequest): Promise<Mission>;
    resume(req: MissionIdRequest): Promise<Mission>;
  };
  approvals: { list(req: ApprovalsListRequest): Promise<Approval[]> };
  /** P5: starts watching a terminal session; "none" when nothing runs there. */
  watch(sessionId: string): Promise<{ status: "started" | "already" | "none"; command: string[] | null }>;
  setQuiet(until: number | null): void;
}

/** French outcome for a failed call (typed IPC codes first); never exposes the raw message. */
export function outcomeFromError(error: unknown): ActionOutcome {
  if (error instanceof NovaIpcError || (error instanceof Error && "code" in error)) {
    const code = (error as { code: unknown }).code;
    if (code === "not_found") return { ok: false, reason: "not_found", message: NOMI_COPY.outcome.notFound };
    if (code === "unavailable") return { ok: false, reason: "unavailable", message: NOMI_COPY.outcome.unavailable };
  }
  // Error messages from main are developer-facing (English): the user gets the French outcome.
  return { ok: false, reason: "failed", message: NOMI_COPY.outcome.failed(NOMI_COPY.outcome.unknownError) };
}

function finishedEvent(events: readonly MissionEvent[], callId: string) {
  for (const event of events) if (event.type === "tool.finished" && event.callId === callId) return event;
  return null;
}

/** Normalized error facts of a signal's source, read from the mission log; null if unknown. */
export function explainSourceFromEvents(events: readonly MissionEvent[], ref: CompanionSourceRef): ExplainSource | null {
  if (ref.kind === "tool_call") {
    const display = finishedEvent(events, ref.toolCallId)?.display;
    if (!display) return null;
    if (display.kind === "command") {
      return { kind: "command", argv: display.argv, exitCode: display.exitCode, signal: display.signal, outputTail: display.outputTail };
    }
    if (display.kind === "tests") return { kind: "tests", passed: display.passed, failed: display.failed, output: null };
    if (display.kind === "error") return { kind: "tool", code: display.code, message: display.message };
    return null;
  }
  if (ref.kind === "mission") {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event?.type === "mission.failed") return { kind: "mission_failed", reason: event.reason, detail: event.detail };
      if (event?.type === "mission.suspended") return { kind: "mission_suspended", reason: event.reason, detail: event.detail };
    }
  }
  return null;
}

async function missionDetail(ports: NomiActionPorts, missionId: string): Promise<MissionDetail> {
  return ports.missions.get({ missionId, afterSeq: 0 });
}

async function perform(action: NomiAction, ports: NomiActionPorts, now: number): Promise<ActionOutcome> {
  const copy = NOMI_COPY.outcome;
  switch (action.type) {
    case "stop_mission": {
      const before = await missionDetail(ports, action.missionId);
      if (isTerminalMissionState(before.mission.state)) return { ok: false, reason: "nothing_to_do", message: copy.nothingToStop };
      const mission = await ports.missions.stop({ missionId: action.missionId });
      return { ok: true, message: copy.missionStopped(mission.title), navigate: null };
    }
    case "resume_mission": {
      const mission = await ports.missions.resume({ missionId: action.missionId });
      return { ok: true, message: copy.missionResumed(mission.title), navigate: null };
    }
    case "start_mission":
      // A mission starts from its contract card (plan, budget, permissions shown and editable):
      // Nomi opens it with the goal filled in, it never starts one blind.
      return { ok: true, message: copy.missionStarted(null), navigate: action };
    case "open_approval": {
      const pending = await ports.approvals.list({ workspaceId: null, missionId: null, status: "pending" });
      if (!pending.some((approval) => approval.id === action.approvalId)) {
        return { ok: false, reason: "nothing_to_do", message: copy.noApproval };
      }
      return { ok: true, message: copy.approvalOpened, navigate: action };
    }
    case "explain_error": {
      const ref = action.sourceRef;
      if (ref.kind === "approval") return { ok: true, message: copy.approvalOpened, navigate: { type: "open_approval", approvalId: ref.approvalId } };
      if (ref.kind === "terminal") return { ok: true, message: copy.outputOpened, navigate: action };
      const detail = await missionDetail(ports, ref.missionId);
      const source = explainSourceFromEvents(detail.events, ref);
      if (!source) return { ok: false, reason: "not_found", message: copy.notFound };
      return { ok: true, message: NOMI_COPY.explain.heading, explanation: explainLocally(source), navigate: null };
    }
    case "explain_source":
      return { ok: true, message: NOMI_COPY.explain.heading, explanation: explainLocally(action.source), navigate: null };
    case "show_changes":
    case "open_diff": {
      const detail = await missionDetail(ports, action.missionId);
      const facts = missionFactsFromEvents(action.missionId, detail.events);
      if (!facts) return { ok: false, reason: "nothing_to_do", message: copy.noChanges };
      const lines = summarizeMissionChanges(facts);
      return { ok: true, message: copy.changesOpened, lines, navigate: action.type === "open_diff" ? action : null };
    }
    case "watch_command": {
      const ref = action.sourceRef;
      if (ref.kind !== "terminal") return { ok: false, reason: "nothing_to_do", message: copy.nothingToWatch };
      const result = await ports.watch(ref.sessionId);
      if (result.status === "none") return { ok: false, reason: "nothing_to_do", message: copy.nothingToWatch };
      if (result.status === "already") return { ok: false, reason: "nothing_to_do", message: copy.alreadyWatching };
      const command = result.command ? shortCommand(result.command) : "la commande";
      return { ok: true, message: copy.watching(command), navigate: null };
    }
    case "quiet":
      ports.setQuiet(action.until !== null && action.until > now ? action.until : null);
      return {
        ok: true,
        message: action.until !== null && action.until > now ? copy.quietOn(action.until) : copy.quietOff,
        navigate: null,
      };
  }
}

/** Runs one Nomi action; every path, errors included, returns a visible outcome. */
export async function performNomiAction(
  action: NomiAction,
  ports: NomiActionPorts,
  now: number = Date.now(),
): Promise<ActionOutcome> {
  try {
    return await perform(action, ports, now);
  } catch (error) {
    return outcomeFromError(error);
  }
}
