// Companion facts: a pure projection of recorded mission events (NOMI.md §6 "faits d'entrée").
// Nothing here guesses: an unknown title, step or count stays null.
import type {
  Approval,
  MissionBudget,
  MissionEvent,
  MissionState,
  MissionSuspendReason,
  ToolName,
} from "@nova/shared";
import { activityForToolStart, type NomiActivity } from "./activity";

export interface FileChangeFact {
  path: string;
  change: "created" | "modified" | "moved" | "deleted";
  additions: number;
  deletions: number;
}

export interface TestRunFact {
  callId: string;
  passed: number | null;
  failed: number | null;
  skipped: number | null;
  exitCode: number | null;
  at: number;
}

export interface CommandRunFact {
  callId: string;
  argv: string[];
  exitCode: number | null;
  outputTail: string;
  at: number;
}

export interface FailureFact {
  callId: string;
  kind: "tests" | "command";
  at: number;
}

export interface MissionFacts {
  missionId: string;
  workspaceId: string | null;
  /** null when the mission was created before Nomi started listening. */
  title: string | null;
  state: MissionState;
  /** 1-based position of the running task, null when unknown. */
  step: number | null;
  steps: number | null;
  suspendReason: MissionSuspendReason | null;
  budget: MissionBudget | null;
  pendingApprovals: Approval[];
  /** Tool names by call id (from `tool.requested`). */
  toolNames: Record<string, ToolName>;
  /** Started and not finished, in start order. */
  runningTools: { callId: string; activity: NomiActivity }[];
  unresolvedFailure: FailureFact | null;
  files: FileChangeFact[];
  tests: TestRunFact[];
  commands: CommandRunFact[];
  checkpoints: number;
  lastCheckpointAt: number | null;
  updatedAt: number;
}

export interface CompanionFactsState {
  missions: Record<string, MissionFacts>;
}

export const EMPTY_COMPANION_FACTS: CompanionFactsState = { missions: {} };

/** Bound on remembered commands/tests per mission (facts are a projection, the log is the truth). */
const MAX_RUNS = 50;

function blankMission(missionId: string, at: number): MissionFacts {
  return {
    missionId,
    workspaceId: null,
    title: null,
    state: "ready",
    step: null,
    steps: null,
    suspendReason: null,
    budget: null,
    pendingApprovals: [],
    toolNames: {},
    runningTools: [],
    unresolvedFailure: null,
    files: [],
    tests: [],
    commands: [],
    checkpoints: 0,
    lastCheckpointAt: null,
    updatedAt: at,
  };
}

function capped<T>(items: T[]): T[] {
  return items.length > MAX_RUNS ? items.slice(items.length - MAX_RUNS) : items;
}

function mergeFile(files: FileChangeFact[], next: FileChangeFact): FileChangeFact[] {
  const existing = files.find((file) => file.path === next.path);
  if (!existing) return [...files, next];
  return files.map((file) =>
    file.path === next.path
      ? {
          path: next.path,
          change: existing.change === "created" && next.change === "modified" ? "created" : next.change,
          additions: existing.additions + next.additions,
          deletions: existing.deletions + next.deletions,
        }
      : file,
  );
}

function applyFinished(
  mission: MissionFacts,
  event: Extract<MissionEvent, { type: "tool.finished" }>,
): MissionFacts {
  const runningTools = mission.runningTools.filter((tool) => tool.callId !== event.callId);
  const display = event.display;
  let next: MissionFacts = { ...mission, runningTools };
  if (display.kind === "file_change") {
    next = {
      ...next,
      files: mergeFile(next.files, {
        path: display.path,
        change: display.change,
        additions: display.additions,
        deletions: display.deletions,
      }),
    };
  } else if (display.kind === "tests") {
    const run: TestRunFact = {
      callId: event.callId,
      passed: display.passed,
      failed: display.failed,
      skipped: display.skipped,
      exitCode: display.exitCode,
      at: event.at,
    };
    const failed = (display.failed ?? 0) > 0 || (display.exitCode !== null && display.exitCode !== 0);
    const passed = display.exitCode === 0 && (display.failed ?? 0) === 0;
    next = {
      ...next,
      tests: capped([...next.tests, run]),
      unresolvedFailure: failed
        ? { callId: event.callId, kind: "tests", at: event.at }
        : passed
          ? null
          : next.unresolvedFailure,
    };
  } else if (display.kind === "command") {
    const run: CommandRunFact = {
      callId: event.callId,
      argv: display.argv,
      exitCode: display.exitCode,
      outputTail: display.outputTail,
      at: event.at,
    };
    const failed = display.exitCode !== null && display.exitCode !== 0;
    next = {
      ...next,
      commands: capped([...next.commands, run]),
      unresolvedFailure: failed ? { callId: event.callId, kind: "command", at: event.at } : next.unresolvedFailure,
    };
  }
  return next;
}

function applyToMission(mission: MissionFacts, event: MissionEvent): MissionFacts {
  const base = { ...mission, updatedAt: event.at };
  switch (event.type) {
    case "mission.created":
      return {
        ...base,
        workspaceId: event.mission.workspaceId,
        title: event.mission.title,
        state: event.mission.state,
      };
    case "mission.started":
      return { ...base, workspaceId: event.contract.workspaceId, state: "running", suspendReason: null };
    case "mission.plan":
      return { ...base, steps: event.tasks.length };
    case "task.updated":
      return event.task.state === "running" ? { ...base, step: event.task.seq + 1 } : base;
    case "tool.requested":
      return { ...base, toolNames: { ...base.toolNames, [event.call.id]: event.call.name } };
    case "tool.started": {
      const name = base.toolNames[event.callId];
      if (!name) return base;
      const activity = activityForToolStart(name, base.unresolvedFailure !== null);
      return { ...base, runningTools: [...base.runningTools, { callId: event.callId, activity }] };
    }
    case "tool.finished":
      return applyFinished(base, event);
    case "approval.requested":
      return {
        ...base,
        state: "waiting_approval",
        pendingApprovals: [...base.pendingApprovals.filter((a) => a.id !== event.approval.id), event.approval],
      };
    case "approval.resolved": {
      const pendingApprovals = base.pendingApprovals.filter((a) => a.id !== event.approval.id);
      const state = base.state === "waiting_approval" && pendingApprovals.length === 0 ? "running" : base.state;
      return { ...base, pendingApprovals, state };
    }
    case "checkpoint.created":
      return { ...base, checkpoints: base.checkpoints + 1, lastCheckpointAt: event.checkpoint.createdAt };
    case "budget.updated":
      return { ...base, budget: event.budget };
    case "mission.suspended":
      return { ...base, state: "suspended", suspendReason: event.reason, runningTools: [] };
    case "mission.resumed":
      return { ...base, state: "running", suspendReason: null };
    case "mission.succeeded":
      return { ...base, state: "succeeded", runningTools: [], pendingApprovals: [], unresolvedFailure: null };
    case "mission.failed":
      return { ...base, state: "failed", runningTools: [], pendingApprovals: [] };
    case "mission.cancelled":
      return { ...base, state: "cancelled", runningTools: [], pendingApprovals: [] };
    case "tool.permission":
    case "tool.output":
    case "message.delta":
    case "message.completed":
    case "proof.recorded":
    case "review.decided":
      return mission;
  }
  return mission;
}

/** Pure reducer: facts after one recorded (or live) mission event. */
export function reduceCompanionFacts(state: CompanionFactsState, event: MissionEvent): CompanionFactsState {
  const current = state.missions[event.missionId] ?? blankMission(event.missionId, event.at);
  const next = applyToMission(current, event);
  if (next === current && state.missions[event.missionId]) return state;
  return { missions: { ...state.missions, [event.missionId]: next } };
}

const FOCUS_ORDER: readonly MissionState[] = ["waiting_approval", "running", "suspended", "ready"];

/** The mission Nomi talks about: waiting first, then running, suspended, ready; newest wins a tie. */
export function focusMission(state: CompanionFactsState): MissionFacts | null {
  let best: MissionFacts | null = null;
  for (const mission of Object.values(state.missions)) {
    const rank = FOCUS_ORDER.indexOf(mission.state);
    if (rank < 0) continue;
    if (!best) {
      best = mission;
      continue;
    }
    const bestRank = FOCUS_ORDER.indexOf(best.state);
    if (rank < bestRank || (rank === bestRank && mission.updatedAt > best.updatedAt)) best = mission;
  }
  return best;
}

/** Latest started, unfinished tool of a running mission; `none` otherwise. */
export function currentActivity(mission: MissionFacts | null): NomiActivity {
  if (!mission || mission.state !== "running") return "none";
  return mission.runningTools.at(-1)?.activity ?? "none";
}

export function allPendingApprovals(state: CompanionFactsState): Approval[] {
  return Object.values(state.missions).flatMap((mission) => mission.pendingApprovals);
}
