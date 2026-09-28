// J2-B slices of a mission view. Each lane owns its slice module under ./harness (pure reducer +
// initial state); this file only composes them and routes each J2-B event to its owner. Frozen
// contract: lanes never edit it (the integrator does, if a new event type appears).
import type { HarnessMissionEvent } from "@nova/shared";
import { initialChainView, reduceChainEvent, type ChainView } from "./harness/chain-view";
import { initialContextView, reduceContextEvent, type ContextView } from "./harness/context-view";
import { initialContinuationView, reduceContinuationEvent, type ContinuationView } from "./harness/continuation-view";
import { initialProcessesView, reduceProcessesEvent, type ProcessesView } from "./harness/processes-view";
import { initialSkillsView, reduceSkillsEvent, type SkillsView } from "./harness/skills-view";
import { initialSubmissionsView, reduceSubmissionsEvent, type SubmissionsView } from "./harness/submissions-view";

export interface HarnessView {
  processes: ProcessesView;
  context: ContextView;
  skills: SkillsView;
  chain: ChainView;
  submissions: SubmissionsView;
  continuation: ContinuationView;
}

export function initialHarnessView(): HarnessView {
  return {
    processes: initialProcessesView(),
    context: initialContextView(),
    skills: initialSkillsView(),
    chain: initialChainView(),
    submissions: initialSubmissionsView(),
    continuation: initialContinuationView(),
  };
}

export function reduceHarnessView(view: HarnessView, event: HarnessMissionEvent): HarnessView {
  switch (event.type) {
    case "tool.terminal":
    case "process.started":
    case "process.ended":
      return { ...view, processes: reduceProcessesEvent(view.processes, event) };
    case "context.usage":
    case "compaction.proposed":
    case "compaction.applied":
    case "compaction.dismissed":
    case "handoff.created":
    case "model.switched":
      return { ...view, context: reduceContextEvent(view.context, event) };
    case "skill.loaded":
      return { ...view, skills: reduceSkillsEvent(view.skills, event) };
    case "chain.started":
    case "chain.finished":
      return { ...view, chain: reduceChainEvent(view.chain, event) };
    case "submission.started":
    case "submission.updated":
      return { ...view, submissions: reduceSubmissionsEvent(view.submissions, event) };
    case "continuation.round":
    case "continuation.stopped":
    case "mission.forked":
      return { ...view, continuation: reduceContinuationEvent(view.continuation, event) };
  }
}
