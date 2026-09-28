// P4 "Qu'est-ce qui a changé ?": facts first (files, tests, commands, checkpoints), each line
// opening its proof. A model-written summary is a separate, paid, explicit step.
import type { MissionEvent } from "@nova/shared";
import { NOMI_COPY } from "./copy";
import { EMPTY_COMPANION_FACTS, reduceCompanionFacts, type MissionFacts } from "./facts";
import { formatUsd } from "./format";

export type ChangeTarget =
  | { kind: "diff"; missionId: string; path: string | null }
  | { kind: "test_output"; missionId: string; callId: string }
  | { kind: "command_output"; missionId: string; callId: string }
  | { kind: "checkpoints"; missionId: string };

export interface ChangeLine {
  text: string;
  /** Where the proof lives; null when there is nothing to open. */
  target: ChangeTarget | null;
}

/** Facts of one mission rebuilt from its persisted log (`missions.get`). */
export function missionFactsFromEvents(missionId: string, events: readonly MissionEvent[]): MissionFacts | null {
  let state = EMPTY_COMPANION_FACTS;
  for (const event of events) if (event.missionId === missionId) state = reduceCompanionFacts(state, event);
  return state.missions[missionId] ?? null;
}

export function summarizeMissionChanges(mission: MissionFacts): ChangeLine[] {
  const { missionId } = mission;
  const copy = NOMI_COPY.changes;
  const lines: ChangeLine[] = [];
  if (mission.files.length > 0) {
    const additions = mission.files.reduce((sum, file) => sum + file.additions, 0);
    const deletions = mission.files.reduce((sum, file) => sum + file.deletions, 0);
    lines.push({ text: copy.files(mission.files.length, additions, deletions), target: { kind: "diff", missionId, path: null } });
  } else {
    lines.push({ text: copy.noFiles, target: null });
  }
  const lastTest = mission.tests.at(-1);
  if (lastTest) {
    lines.push({
      text: copy.tests(mission.tests.length, lastTest.passed, lastTest.failed),
      target: { kind: "test_output", missionId, callId: lastTest.callId },
    });
  } else {
    lines.push({ text: copy.noTests, target: null });
  }
  if (mission.commands.length > 0) {
    const failed = mission.commands.filter((command) => command.exitCode !== null && command.exitCode !== 0).length;
    const last = mission.commands.at(-1);
    lines.push({
      text: copy.commands(mission.commands.length, failed),
      target: last ? { kind: "command_output", missionId, callId: last.callId } : null,
    });
  }
  if (mission.checkpoints > 0) {
    lines.push({ text: copy.checkpoint(mission.checkpoints, mission.lastCheckpointAt), target: { kind: "checkpoints", missionId } });
  }
  return lines;
}

export interface ConversationFacts {
  messages: number;
  models: number;
  /** Sum of reported costs. */
  cost: number;
  /** Messages whose cost was not reported: the sum becomes a lower bound. */
  messagesWithUnknownCost: number;
}

/** J1 version of P4: "4 messages, 2 modèles utilisés, au moins 0,02 $". */
export function summarizeConversation(facts: ConversationFacts): string {
  const unknownOnly = facts.cost === 0 && facts.messagesWithUnknownCost > 0;
  const cost = unknownOnly ? NOMI_COPY.changes.costUnknown : formatUsd(facts.cost, facts.messagesWithUnknownCost > 0);
  return NOMI_COPY.changes.conversation(facts.messages, facts.models, cost);
}
