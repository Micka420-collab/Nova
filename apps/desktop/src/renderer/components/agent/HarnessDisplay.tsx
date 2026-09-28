// Routes J2-B tool displays to the owning lane's card body (./harness). Frozen: lanes edit their
// own component, not this dispatcher.
import type { ToolDisplay } from "@nova/shared";
import { ChainDisplay } from "./harness/ChainDisplay";
import { ProcessDisplay } from "./harness/ProcessDisplay";
import { SkillDisplay } from "./harness/SkillDisplay";
import { SubmissionDisplay } from "./harness/SubmissionDisplay";

export type HarnessToolDisplay = Extract<ToolDisplay, { kind: "process" | "skill" | "chain" | "submission" }>;

export function HarnessDisplay({ display }: { display: HarnessToolDisplay }) {
  switch (display.kind) {
    case "process":
      return <ProcessDisplay display={display} />;
    case "skill":
      return <SkillDisplay display={display} />;
    case "chain":
      return <ChainDisplay display={display} />;
    case "submission":
      return <SubmissionDisplay display={display} />;
  }
}
