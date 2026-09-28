// J2-B executors, one factory per lane (frozen composition: lanes edit their own factory file).
import type { ToolDeps } from "./apis";
import { createChainExecutors } from "./chain-tool";
import type { ToolExecutor } from "./index";
import { createProcessExecutors } from "./process-tools";
import { createSkillExecutors } from "./skill-tool";
import { createSubmissionExecutors } from "./submission-tool";

export function createHarnessExecutors(deps: ToolDeps): ToolExecutor[] {
  return [
    ...createProcessExecutors(deps),
    ...createSkillExecutors(deps),
    ...createChainExecutors(deps),
    ...createSubmissionExecutors(deps),
  ];
}
