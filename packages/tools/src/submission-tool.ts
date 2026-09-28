// L5 — executor of `start_submission` over `ToolDeps.submissions`. Offered only when the mission
// contract enables sub-missions (missionToolSet) and main wired the controller; never to a
// sub-mission (its contract has no sub-missions).
//
// The executor starts nothing itself: `ToolDeps.submissions.start` (main) checks the bounds (depth
// 1, children, parallel), reserves the child's budget on this mission, derives a narrower contract,
// creates the worktree of a writing child and starts it. The loop does not wait for the child: the
// result says so, and that a writing child's changes reach the project only when the user
// integrates them. Each start is journaled on this mission (`submission.started`).
import { z } from "zod";
import { SUBMISSION_LIMITS, type JsonSchemaObject, type ToolErrorCode, type WorkMode } from "@nova/shared";
import type { SubmissionsApi, ToolDeps } from "./apis";
import { ToolFailure, makeResult, provenance } from "./content";
import type { ExecutedToolResult, ToolExecutionContext, ToolExecutor } from "./index";

const MODES = ["understand", "plan", "build", "fix", "verify"] as const satisfies readonly Exclude<WorkMode, "discuss">[];

const ArgsSchema = z
  .object({
    title: z.string().trim().min(1).max(120).describe("short title of the sub-mission, in the user's language"),
    goal: z
      .string()
      .trim()
      .min(1)
      .max(SUBMISSION_LIMITS.goalMaxChars)
      .describe("self-contained goal: what to do, where, and how to know it is done (the sub-mission does not see this conversation)"),
    mode: z
      .enum(MODES)
      .describe("understand / plan / verify: read-only; build / fix: may change files, in its own copy of the project"),
    budgetUsd: z.number().positive().max(1_000).describe("budget reserved from this mission's budget for the sub-mission, in USD"),
  })
  .strict();

type SubmissionArgs = z.output<typeof ArgsSchema>;

const DESCRIPTION = [
  "Delegate one self-contained sub-goal to a sub-mission that runs on its own, in parallel, with a contract no wider than yours.",
  "Use it for independent work (explore one area, write tests for one module) while you continue; do not use it for the next step you need right away.",
  "Its budget is reserved from yours before it starts and refused if it does not fit. You do not receive its result in this mission.",
  "A build/fix sub-mission works in its own copy of the project: its changes reach the project only after its tests pass and the user integrates them.",
  `Limits: at most ${SUBMISSION_LIMITS.maxChildren} sub-missions per mission (your contract may allow fewer), ${SUBMISSION_LIMITS.maxParallel} running at once; a sub-mission cannot start sub-missions.`,
].join(" ");

function inputSchema(): JsonSchemaObject {
  const json = z.toJSONSchema(ArgsSchema, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
  delete json["$schema"];
  return json as unknown as JsonSchemaObject;
}

/** Controller refusals (`SubmissionError` codes of @nova/missions) as tool errors. */
const ERROR_CODES: Readonly<Record<string, ToolErrorCode>> = {
  invalid_request: "invalid_arguments",
  not_found: "not_found",
  conflict: "conflict",
  unavailable: "unavailable",
  provider: "failed",
};

function toFailure(error: unknown): ToolFailure {
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  const mapped = typeof code === "string" ? ERROR_CODES[code] : undefined;
  if (!mapped) return new ToolFailure("failed", "the sub-mission could not start; continue yourself");
  const message = error instanceof Error ? error.message.slice(0, 400) : String(code);
  return new ToolFailure(mapped, message);
}

function usd(amount: number): string {
  return `${amount.toFixed(amount < 0.01 ? 4 : 2)} USD`;
}

export function createSubmissionExecutors(deps: ToolDeps): ToolExecutor[] {
  const submissions: SubmissionsApi | null = deps.submissions ?? null;
  if (!submissions) return [];

  const executor: ToolExecutor<SubmissionArgs> = {
    name: "start_submission",
    operation: "read",
    definition: { name: "start_submission", description: DESCRIPTION, inputSchema: inputSchema(), operation: "read" },
    argsSchema: ArgsSchema as unknown as z.ZodType<SubmissionArgs>,
    // No effect of its own: the child's contract is a subset of this one and each of its calls is
    // evaluated; its writes reach the project only through a checkpointed integration.
    permissionFacts: () => [{}],
    checkpointPaths: () => [],
    async execute(args, context: ToolExecutionContext): Promise<ExecutedToolResult> {
      const started = Date.now();
      let outcome: Awaited<ReturnType<SubmissionsApi["start"]>>;
      try {
        outcome = await submissions.start(
          { parentMissionId: context.missionId, workspaceId: context.workspaceId, title: args.title, goal: args.goal, mode: args.mode, budgetUsd: args.budgetUsd },
          context.signal,
        );
      } catch (error) {
        if (context.signal.aborted) throw error;
        throw toFailure(error);
      }
      const { link, title } = outcome;
      context.record?.({ type: "submission.started", link, title });
      const writes = link.worktree !== null;
      const content = [
        `Sub-mission ${link.childMissionId} "${title}" started in mode ${args.mode}, with ${usd(link.reservedUsd ?? args.budgetUsd)} reserved from your budget.`,
        "It runs on its own: do not wait for it and do not redo its work; its result is not sent to you.",
        writes
          ? "It works in its own copy of the project: its changes reach the project only after its tests pass and the user integrates them."
          : "It does not change files.",
      ].join("\n");
      return makeResult({
        callId: context.callId,
        ok: true,
        content,
        display: { kind: "submission", childMissionId: link.childMissionId, title, reservedUsd: link.reservedUsd, integration: link.integration },
        provenance: provenance("nova", null),
        durationMs: Date.now() - started,
      });
    },
  };
  return [executor as ToolExecutor];
}
