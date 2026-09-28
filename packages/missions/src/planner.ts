// A9: the plan is a dedicated model call whose JSON answer is repaired, then validated by zod.
// An answer that stays invalid after one corrective retry is an error (no invented plan).
import { parseToolArguments, z } from "@nova/tools";
import type { UsageSummary, WorkMode, WorkspaceFacts } from "@nova/shared";
import { ProxyError, type ProviderProxy, type ProxyMessage } from "./index";

export const PLAN_SCHEMA = z.object({
  summary: z.string().trim().min(1).max(1_000),
  tasks: z
    .array(
      z.object({
        title: z.string().trim().min(1).max(300),
        acceptance: z.object({
          kind: z.enum(["test_passes", "command_succeeds", "file_exists", "manual"]),
          detail: z.string().max(1_000).default(""),
        }),
      }),
    )
    .min(1)
    .max(12),
});

export type PlanOutcome = z.infer<typeof PLAN_SCHEMA> & { usage: UsageSummary | null };

const CHECKABLE_MODES: readonly WorkMode[] = ["build", "fix", "verify"];

function systemPrompt(mode: WorkMode, facts: WorkspaceFacts | null): string {
  const checkable = CHECKABLE_MODES.includes(mode);
  const runner = facts?.testRunner ? `The project's tests run with: ${facts.testRunner.command.join(" ")} (${facts.testRunner.name}).` : "No test runner was detected in this project.";
  return [
    "You are the planner of NOVA, a coding workshop. Produce the plan of a mission as ONE JSON object and nothing else:",
    '{"summary": string, "tasks": [{"title": string, "acceptance": {"kind": "test_passes" | "command_succeeds" | "file_exists" | "manual", "detail": string}}]}',
    "- summary: one or two sentences in French, addressed to the user with « tu ».",
    "- tasks: 1 to 8 concrete steps in order, titles in French (imperative, short).",
    "- acceptance says how NOVA checks the step: test_passes (detail: test file or name), command_succeeds (detail: the exact command), file_exists (detail: workspace-relative path), manual (the user confirms).",
    checkable
      ? `- Prefer checkable criteria. ${runner}`
      : `- The mode "${mode}" cannot run commands: use "manual" for every criterion.`,
    "Do not call tools. Do not add text around the JSON.",
  ].join("\n");
}

function extractJson(text: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = (fenced?.[1] ?? text).trim();
  const start = body.indexOf("{");
  return start === -1 ? body : body.slice(start);
}

export async function planMission(input: {
  proxy: ProviderProxy;
  missionId: string;
  modelId: string;
  goal: string;
  mode: WorkMode;
  facts: WorkspaceFacts | null;
  signal: AbortSignal;
}): Promise<PlanOutcome> {
  const messages: ProxyMessage[] = [
    { role: "system", content: systemPrompt(input.mode, input.facts) },
    { role: "user", content: `Mode: ${input.mode}\nGoal:\n${input.goal}` },
  ];
  let usage: UsageSummary | null = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let text = "";
    const stream = input.proxy.stream(
      { missionId: input.missionId, modelId: input.modelId, messages, tools: [], webSearch: false, maxTokens: 2_000, purpose: "plan" },
      input.signal,
    );
    for await (const event of stream) {
      if (event.type === "text") text += event.text;
      else if (event.type === "usage") usage = event.usage;
    }
    const parsed = parseToolArguments(extractJson(text), PLAN_SCHEMA);
    if (parsed.ok) {
      const plan = parsed.args;
      if (!CHECKABLE_MODES.includes(input.mode)) {
        for (const task of plan.tasks) task.acceptance = { kind: "manual", detail: task.acceptance.detail };
      }
      return { ...plan, usage };
    }
    messages.push({ role: "assistant", content: text.slice(0, 20_000), toolCalls: [] });
    messages.push({ role: "user", content: `That was not valid: ${parsed.error}. Answer again with the JSON object only.` });
  }
  throw new ProxyError("provider_error", "the model did not return a valid plan");
}
