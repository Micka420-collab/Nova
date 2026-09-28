// L8 "jusqu'à preuve": main side of the loop's continuation hook (`MainRuntimeHandlers.continuation`).
// The runtime asks for another round when a round ended with checkable criteria still unproven;
// this core decides from recorded facts only (the contract, the stored tasks and events, the cost
// ledger) and journals every decision: `continuation.round` when a round starts,
// `continuation.stopped` with its reason when it will not (or when the mission ends after rounds).
// Bounds: `maxRounds` rounds, and a spend cap for all rounds together counted from the moment
// the first round was asked for, inside the mission budget (the provider proxy still enforces
// the mission budget on every call). `manual` criteria never start a round.
import { missionHarnessOf, redactSecrets, type ContinuationStopReason, type MissionContract, type MissionEvent, type MissionTask } from "@nova/shared";
import { isCheckable } from "../acceptance";
import type { MissionEventInput } from "../index";
import type { LoopContinuationHook, OpenCriterion } from "../loop";
import { missionToolSet } from "../tool-set";

/** Spend recorded for a mission (the cost ledger: `MissionStoreLike.cost.summary`). */
export interface ContinuationSpend {
  spentUsd: number;
  reservedUsd: number;
  /** Calls whose cost the provider did not report: the spend is then a lower bound. */
  unknownCostCalls: number;
}

export interface ContinuationCoreDeps {
  /** The mission's contract (`MissionController.contractOf`); null = unknown mission. */
  contractOf(missionId: string): MissionContract | null;
  /** Stored tasks with their acceptance (`MissionStoreLike.listTasks`). */
  tasks(missionId: string): readonly MissionTask[];
  /** Stored events with seq > afterSeq, oldest first (`listEvents` + `eventFromRecord`). */
  events(missionId: string, afterSeq: number): readonly MissionEvent[];
  spend(missionId: string): ContinuationSpend;
  /** `MissionController.journal` (drops events after the terminal one). */
  journal: { append(event: MissionEventInput): MissionEvent | null };
}

export interface ContinuationCore {
  /** Wire as `MainRuntimeHandlers.continuation`. */
  hook: LoopContinuationHook;
  /**
   * Call with every event the runtime appends, BEFORE appending it: when a mission that went
   * through rounds ends, its `continuation.stopped` (proven / user) is journaled first, because
   * the journal accepts nothing after the terminal event.
   */
  beforeRuntimeEvent(event: MissionEventInput): void;
}

/** Longest criterion line in the continuation prompt (titles and reasons are plan/tool text). */
const PROMPT_LINE_MAX_CHARS = 300;
/** Criteria listed in one continuation prompt. */
const PROMPT_MAX_CRITERIA = 20;

interface RoundState {
  /** Spend when the first round was asked for (null until then). */
  baseline: ContinuationSpend | null;
  /** Unproven criteria (id + reason) when the previous round was started. */
  lastSignature: string | null;
}

interface JournalFacts {
  rounds: number;
  stopped: boolean;
  lastRoundSeq: number | null;
}

/**
 * Whether NOVA can prove this criterion in this mission: the loop's own rule (a checkable
 * criterion, and a mode that can run commands for test/command criteria), so this core never
 * counts as provable what the loop leaves « to confirm by you ».
 */
function provable(task: MissionTask, contract: MissionContract): boolean {
  if (!isCheckable(task.acceptance)) return false;
  if (task.acceptance.kind !== "test_passes" && task.acceptance.kind !== "command_succeeds") return true;
  const tools = missionToolSet(contract.mode, { webSearch: false, mcpTools: [] });
  return tools.has("run_tests") || tools.has("run_command");
}

function signatureOf(open: readonly OpenCriterion[]): string {
  return open
    .map((criterion) => `${criterion.taskId}\u0000${criterion.reason}`)
    .toSorted()
    .join("\u0001");
}

function clip(text: string, max: number): string {
  const line = redactSecrets(text).replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** The user message that starts a continuation round (model-facing, English like the loop's nudges). */
export function continuationPrompt(input: { round: number; maxRounds: number; open: readonly OpenCriterion[] }): string {
  const listed = input.open.slice(0, PROMPT_MAX_CRITERIA).map((criterion) => `- ${clip(`${criterion.title}: ${criterion.reason}`, PROMPT_LINE_MAX_CHARS)}`);
  const more = input.open.length > PROMPT_MAX_CRITERIA ? [`- … and ${input.open.length - PROMPT_MAX_CRITERIA} more`] : [];
  return [
    `Continuation round ${input.round} of ${input.maxRounds}: the mission is not finished. These acceptance criteria are still not proven by a tool result:`,
    ...listed,
    ...more,
    "Keep working: find why they fail, fix it, then run the checks again with the tools (NOVA only trusts what it ran). If something outside your reach blocks you, say what, without calling a tool.",
  ].join("\n");
}

export function createContinuationCore(deps: ContinuationCoreDeps): ContinuationCore {
  const states = new Map<string, RoundState>();

  const factsOf = (missionId: string): JournalFacts => {
    let rounds = 0;
    let stopped = false;
    let lastRoundSeq: number | null = null;
    for (const event of deps.events(missionId, 0)) {
      if (event.type === "continuation.round") {
        rounds += 1;
        lastRoundSeq = event.seq;
      } else if (event.type === "continuation.stopped") {
        stopped = true;
      }
    }
    return { rounds, stopped, lastRoundSeq };
  };

  const stop = (missionId: string, reason: ContinuationStopReason, rounds: number): null => {
    deps.journal.append({ type: "continuation.stopped", missionId, reason, rounds });
    states.delete(missionId);
    return null;
  };

  /** What the last round did: calls that succeeded, and whether one of them changed a file. */
  const roundActivity = (missionId: string, sinceSeq: number): { succeeded: number; changedFiles: boolean } => {
    let succeeded = 0;
    let changedFiles = false;
    for (const event of deps.events(missionId, sinceSeq)) {
      if (event.type !== "tool.finished" || event.state !== "succeeded") continue;
      succeeded += 1;
      if (event.display.kind === "file_change") changedFiles = true;
    }
    return { succeeded, changedFiles };
  };

  /** Why the spend forbids another round, or null. */
  const budgetStop = (missionId: string, contract: MissionContract, capUsd: number, state: RoundState): boolean => {
    const spend = deps.spend(missionId);
    const baseline = state.baseline ?? spend;
    state.baseline = baseline;
    // A call of unknown cost since the first round makes the cap unverifiable: never assume it held.
    if (spend.unknownCostCalls > baseline.unknownCostCalls) return true;
    const used = spend.spentUsd + spend.reservedUsd - (baseline.spentUsd + baseline.reservedUsd);
    if (used >= capUsd) return true;
    return spend.spentUsd + spend.reservedUsd >= contract.budgetUsd;
  };

  const hook: LoopContinuationHook = {
    async nextRound({ missionId, open }) {
      const contract = deps.contractOf(missionId);
      const options = contract ? missionHarnessOf(contract).autoContinue : null;
      // Off (the default): the mission ends as without this lane, and nothing is journaled.
      if (!contract || !options) return null;
      const facts = factsOf(missionId);
      if (facts.stopped) return null;
      const state = states.get(missionId) ?? { baseline: null, lastSignature: null };
      states.set(missionId, state);

      // Only criteria NOVA can check itself start a round (manual ones stay « to confirm by you »).
      const tasks = new Map(deps.tasks(missionId).map((task) => [task.id, task]));
      const checkable = open.filter((criterion) => {
        const task = tasks.get(criterion.taskId);
        return task !== undefined && provable(task, contract);
      });
      if (checkable.length === 0) return stop(missionId, "manual_only", facts.rounds);
      if (facts.rounds >= options.maxRounds) return stop(missionId, "max_rounds", facts.rounds);
      if (budgetStop(missionId, contract, options.budgetUsd, state)) return stop(missionId, "budget", facts.rounds);

      const signature = signatureOf(checkable);
      if (facts.lastRoundSeq !== null) {
        const activity = roundActivity(missionId, facts.lastRoundSeq);
        const unchanged = signature === state.lastSignature && !activity.changedFiles;
        if (activity.succeeded === 0 || unchanged) return stop(missionId, "no_progress", facts.rounds);
      }

      const round = facts.rounds + 1;
      const stored = deps.journal.append({
        type: "continuation.round",
        missionId,
        round,
        maxRounds: options.maxRounds,
        unprovenTaskIds: checkable.map((criterion) => criterion.taskId),
      });
      // The mission ended meanwhile (stop, crash): no round.
      if (!stored) {
        states.delete(missionId);
        return null;
      }
      state.lastSignature = signature;
      return { prompt: continuationPrompt({ round, maxRounds: options.maxRounds, open: checkable }) };
    },
  };

  return {
    hook,
    beforeRuntimeEvent(event) {
      if (event.type !== "mission.succeeded" && event.type !== "mission.cancelled" && event.type !== "mission.failed") return;
      const { missionId } = event;
      states.delete(missionId);
      // A failure explains itself; a system cancel is not the user's stop.
      if (event.type === "mission.failed" || (event.type === "mission.cancelled" && event.by !== "user")) return;
      const facts = factsOf(missionId);
      if (facts.stopped) return;
      if (facts.rounds > 0) {
        // The loop only succeeds once every checkable criterion is verified by a tool result.
        const reason: ContinuationStopReason = event.type === "mission.succeeded" ? "proven" : "user";
        deps.journal.append({ type: "continuation.stopped", missionId, reason, rounds: facts.rounds });
        return;
      }
      // Option on but nothing NOVA can prove: say so once, instead of a silent no-op.
      const contract = deps.contractOf(missionId);
      if (event.type !== "mission.succeeded" || !contract || !missionHarnessOf(contract).autoContinue) return;
      if (deps.tasks(missionId).some((task) => provable(task, contract))) return;
      deps.journal.append({ type: "continuation.stopped", missionId, reason: "manual_only", rounds: 0 });
    },
  };
}
