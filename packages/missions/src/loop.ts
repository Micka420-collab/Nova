// The mission loop (A1/A9): model turn → tool calls through main → results back → … until the
// model stops calling tools, then acceptance is checked against real results. Runs in the
// agent-runtime utilityProcess; every observable step is an event sent to main's journal.
import { randomUUID } from "node:crypto";
import { ToolCallAssembler, mergeReasoningDetails, type AssembledToolCall } from "@nova/providers";
import type {
  MissionFailureReason,
  MissionSuspendReason,
  MissionTask,
  ToolResult,
  UsageSummary,
} from "@nova/shared";
import { evaluateAcceptance, isCheckable, type AcceptanceEvidence } from "./acceptance";
import {
  ProxyError,
  type MissionEventInput,
  type MissionEventSink,
  type MissionRunSpec,
  type MissionRuntime,
  type ProviderProxy,
  type ProxyMessage,
  type SystemPromptBuilder,
  type ToolGateway,
} from "./index";
import { NoProgressDetector } from "./no-progress";

export interface LoopLimits {
  /** Model calls per mission before failing with `iteration_limit`. */
  maxIterations: number;
  /** Output cap per call (bounds each budget reservation). */
  maxTokensPerCall: number;
  /** Retries of a retryable provider failure (network, rate limit…) per call. */
  providerRetries: number;
  retryDelayMs: number;
}

export const DEFAULT_LOOP_LIMITS: LoopLimits = {
  maxIterations: 40,
  maxTokensPerCall: 8_192,
  providerRetries: 1,
  retryDelayMs: 2_000,
};

export interface MissionLoopDeps {
  proxy: ProviderProxy;
  gateway: ToolGateway;
  sink: MissionEventSink;
  systemPrompt: SystemPromptBuilder;
  limits?: Partial<LoopLimits>;
  now?: () => number;
  newId?: () => string;
}

/** Ends the run with one terminal event (thrown inside the loop, caught once at the top). */
class Terminal extends Error {
  constructor(readonly event: MissionEventInput) {
    super(event.type);
  }
}

interface Turn {
  text: string;
  toolCalls: AssembledToolCall[];
  reasoningDetails: unknown[];
  finish: string;
}

const RUN_TOOLS = new Set(["run_tests", "run_command"]);

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

class MissionRun {
  readonly controller = new AbortController();
  private terminated = false;
  private pauseRequested = false;
  private resumeWaiter: (() => void) | null = null;
  private deadline: number;
  private readonly noProgress = new NoProgressDetector();
  private readonly evidence: AcceptanceEvidence[] = [];
  private readonly taskStates = new Map<string, MissionTask["state"]>();
  private readonly tasks: MissionTask[];

  constructor(
    private readonly spec: MissionRunSpec,
    private readonly deps: Required<Omit<MissionLoopDeps, "limits">> & { limits: LoopLimits },
  ) {
    this.deadline = deps.now() + spec.contract.maxDurationMs;
    // Criteria NOVA cannot check (no command given, or the mode has no tool to run it) are left to
    // the user, like `manual`.
    const canRun = spec.tools.some((tool) => RUN_TOOLS.has(tool.name));
    this.tasks = spec.tasks.map((task) =>
      !isCheckable(task.acceptance) || (!canRun && (task.acceptance.kind === "test_passes" || task.acceptance.kind === "command_succeeds"))
        ? { ...task, acceptance: { kind: "manual", detail: task.acceptance.detail } }
        : task,
    );
    for (const task of spec.tasks) this.taskStates.set(task.id, task.state);
  }

  get missionId(): string {
    return this.spec.mission.id;
  }

  private emit(event: MissionEventInput): void {
    if (this.terminated) return;
    this.deps.sink.append(event);
  }

  private terminate(event: MissionEventInput): void {
    if (this.terminated) return;
    this.deps.sink.append(event);
    this.terminated = true;
  }

  pause(): void {
    this.pauseRequested = true;
  }

  resume(): void {
    this.pauseRequested = false;
    this.resumeWaiter?.();
  }

  stop(): void {
    this.controller.abort();
    this.resumeWaiter?.();
  }

  async run(): Promise<void> {
    try {
      await this.loop();
    } catch (error) {
      if (error instanceof Terminal) this.terminate(error.event);
      else if (this.controller.signal.aborted) this.terminate({ type: "mission.cancelled", missionId: this.missionId, by: "user" });
      else this.terminate({ type: "mission.failed", missionId: this.missionId, reason: "internal", detail: "erreur interne du runtime" });
    }
    // A stop that raced the last step still ends the mission as cancelled (idempotent).
    if (!this.terminated) this.terminate({ type: "mission.cancelled", missionId: this.missionId, by: "user" });
  }

  private checkAborted(): void {
    if (this.controller.signal.aborted) throw new Terminal({ type: "mission.cancelled", missionId: this.missionId, by: "user" });
  }

  private fail(reason: MissionFailureReason, detail: string | null): Terminal {
    return new Terminal({ type: "mission.failed", missionId: this.missionId, reason, detail });
  }

  /**
   * Suspends until resume (or stop). The duration cap counts working time only: time spent
   * suspended pushes the deadline back, and a duration suspension grants a new window on resume.
   */
  private async suspend(reason: MissionSuspendReason, detail: string | null): Promise<void> {
    const suspendedAt = this.deps.now();
    this.emit({ type: "mission.suspended", missionId: this.missionId, reason, detail });
    this.pauseRequested = false;
    await new Promise<void>((resolve) => {
      this.resumeWaiter = resolve;
    });
    this.resumeWaiter = null;
    this.checkAborted();
    this.emit({ type: "mission.resumed", missionId: this.missionId });
    const resumedAt = this.deps.now();
    this.deadline = reason === "duration" ? resumedAt + this.spec.contract.maxDurationMs : this.deadline + (resumedAt - suspendedAt);
    if (reason === "no_progress") this.noProgress.reset();
  }

  /** Between steps: stop, pause and the duration cap take effect here. */
  private async gate(): Promise<void> {
    this.checkAborted();
    if (this.pauseRequested) await this.suspend("user", null);
    if (this.deps.now() > this.deadline) {
      const minutes = Math.round(this.spec.contract.maxDurationMs / 60_000);
      await this.suspend("duration", `durée maximale atteinte (${minutes} min)`);
    }
  }

  private initialMessages(): ProxyMessage[] {
    const { mission, contract, tools, planSummary } = this.spec;
    const system = this.deps.systemPrompt({
      mode: mission.mode,
      toolNames: tools.map((tool) => tool.name),
      webSearch: contract.webSearch,
    });
    const plan = this.tasks
      .map((task, index) => `${index + 1}. ${task.title} — acceptance: ${task.acceptance.kind}${task.acceptance.detail ? ` (${task.acceptance.detail})` : ""}`)
      .join("\n");
    const user = [
      `Goal: ${mission.goal}`,
      planSummary ? `Plan: ${planSummary}` : null,
      plan ? `Steps:\n${plan}` : null,
      "Work with the tools. When everything is done and checked, answer with a short summary for the user, without calling a tool.",
    ]
      .filter(Boolean)
      .join("\n\n");
    return [
      { role: "system", content: system },
      { role: "user", content: user },
    ];
  }

  private async loop(): Promise<void> {
    const messages = this.initialMessages();
    let iterations = 0;
    let nudged = false;
    for (;;) {
      await this.gate();
      if (iterations >= this.deps.limits.maxIterations) {
        throw this.fail("iteration_limit", `${this.deps.limits.maxIterations} appels au modèle sans conclure`);
      }
      iterations += 1;
      const turn = await this.callModel(messages);
      messages.push({
        role: "assistant",
        content: turn.text,
        toolCalls: turn.toolCalls.map(({ id, name, arguments: args }) => ({ id, name, arguments: args })),
        ...(turn.reasoningDetails.length > 0 ? { reasoningDetails: turn.reasoningDetails } : {}),
      });

      if (turn.toolCalls.length === 0) {
        if (turn.finish === "length") {
          messages.push({ role: "user", content: "Your answer was cut by the output limit. Continue, more briefly." });
          continue;
        }
        const verdicts = this.updateTasks();
        const manual = new Set(this.tasks.filter((task) => task.acceptance.kind === "manual").map((task) => task.id));
        const open = verdicts.filter((verdict) => verdict.state !== "verified" && !manual.has(verdict.taskId));
        if (open.length === 0) {
          const summary = turn.text.trim().slice(0, 4_000) || "Mission terminée.";
          throw new Terminal({ type: "mission.succeeded", missionId: this.missionId, summary });
        }
        if (!nudged) {
          nudged = true;
          const list = open.map((verdict) => `- ${this.taskTitle(verdict.taskId)}: ${verdict.reason}`).join("\n");
          messages.push({
            role: "user",
            content: `Before finishing, the acceptance criteria must be verified with the tools (NOVA only trusts what it ran):\n${list}\nFix what fails, run the checks, or explain what blocks you.`,
          });
          continue;
        }
        const detail = open.map((verdict) => `${this.taskTitle(verdict.taskId)} : ${verdict.reason}`).join(" ; ");
        throw this.fail("acceptance_failed", detail.slice(0, 1_000));
      }

      for (const call of turn.toolCalls) {
        await this.gate();
        const result = await this.runTool(call);
        messages.push({ role: "tool", toolCallId: call.id, content: result.content });
        if (this.noProgress.record(call.name, call.arguments, result)) {
          await this.suspend("no_progress", `« ${call.name} » a donné trois fois le même résultat avec les mêmes arguments`);
        }
      }
    }
  }

  private taskTitle(taskId: string): string {
    return this.tasks.find((task) => task.id === taskId)?.title ?? "étape";
  }

  /** Recomputes acceptance from the evidence and emits `task.updated` for every change. */
  private updateTasks(): ReturnType<typeof evaluateAcceptance> {
    const verdicts = evaluateAcceptance(this.tasks, this.evidence);
    for (const verdict of verdicts) {
      const task = this.spec.tasks.find((candidate) => candidate.id === verdict.taskId);
      if (!task || this.taskStates.get(task.id) === verdict.state) continue;
      this.taskStates.set(task.id, verdict.state);
      this.emit({ type: "task.updated", missionId: this.missionId, task: { ...task, state: verdict.state } });
    }
    return verdicts;
  }

  private async runTool(call: AssembledToolCall): Promise<ToolResult> {
    if (call.overflow) {
      // Oversized arguments are never sent for execution.
      return {
        callId: call.id,
        ok: false,
        content: "Error (too_large): the arguments of this call were too large; split the work into smaller calls.",
        display: { kind: "error", code: "too_large", message: "arguments trop volumineux" },
        provenance: { source: "nova", untrusted: false, ref: null },
        durationMs: 0,
      };
    }
    const result = await this.deps.gateway.run(
      {
        id: this.deps.newId(),
        providerCallId: call.id,
        missionId: this.missionId,
        name: call.name,
        rawArguments: call.arguments,
        requestedAt: this.deps.now(),
      },
      this.controller.signal,
    );
    this.checkAborted();
    this.evidence.push({ ok: result.ok, display: result.display });
    this.updateTasks();
    return result;
  }

  private async callModel(messages: ProxyMessage[]): Promise<Turn> {
    let retries = 0;
    for (;;) {
      this.checkAborted();
      const messageId = this.deps.newId();
      try {
        return await this.streamTurn(messages, messageId);
      } catch (error) {
        this.checkAborted();
        if (error instanceof Terminal) throw error;
        const proxyError = error instanceof ProxyError ? error : null;
        const code = proxyError?.code ?? (typeof (error as { code?: unknown })?.code === "string" ? String((error as { code: string }).code) : "unknown");
        if (code === "budget" || code === "daily_budget") {
          await this.suspend(code === "budget" ? "budget" : "daily_budget", proxyError?.message ?? null);
          continue;
        }
        if (code === "no_tool_support") throw this.fail("no_tool_support", "ce modèle ne sait pas utiliser d'outils");
        const retryable = proxyError?.retryable ?? (error as { retryable?: unknown })?.retryable === true;
        if (retryable && retries < this.deps.limits.providerRetries) {
          retries += 1;
          await sleep(this.deps.limits.retryDelayMs * retries, this.controller.signal);
          continue;
        }
        throw this.fail("provider_error", code);
      }
    }
  }

  private async streamTurn(messages: ProxyMessage[], messageId: string): Promise<Turn> {
    const assembler = new ToolCallAssembler();
    const reasoning: unknown[] = [];
    let text = "";
    let usage: UsageSummary | null = null;
    let finish = "unknown";
    const stream = this.deps.proxy.stream(
      {
        missionId: this.missionId,
        modelId: this.spec.mission.modelId ?? "",
        messages,
        tools: this.spec.tools,
        webSearch: false,
        maxTokens: this.deps.limits.maxTokensPerCall,
        purpose: "step",
      },
      this.controller.signal,
    );
    for await (const event of stream) {
      switch (event.type) {
        case "text":
          text += event.text;
          this.emit({ type: "message.delta", missionId: this.missionId, messageId, text: event.text });
          break;
        case "tool_call_delta":
          assembler.push(event);
          break;
        case "reasoning_details":
          reasoning.push(...event.details);
          break;
        case "usage":
          // Cumulative per generation: keep the last one.
          usage = event.usage;
          break;
        case "finish":
          finish = event.reason;
          break;
        default:
          break;
      }
    }
    if (finish === "content_filter") throw this.fail("provider_error", "réponse bloquée par le filtre du fournisseur");
    if (finish === "error") throw new ProxyError("provider_error", "generation ended with an error", true);
    this.emit({ type: "message.completed", missionId: this.missionId, messageId, content: text, usage });
    return { text, toolCalls: assembler.finish(), reasoningDetails: mergeReasoningDetails(reasoning), finish };
  }
}

export class MissionLoop implements MissionRuntime {
  private readonly runs = new Map<string, { run: MissionRun; done: Promise<void> }>();
  private readonly deps: Required<Omit<MissionLoopDeps, "limits">> & { limits: LoopLimits };

  constructor(deps: MissionLoopDeps) {
    this.deps = {
      ...deps,
      limits: { ...DEFAULT_LOOP_LIMITS, ...deps.limits },
      now: deps.now ?? Date.now,
      newId: deps.newId ?? randomUUID,
    };
  }

  /** Runs the mission to its terminal event; resolves then. Starting a running mission is a no-op. */
  start(spec: MissionRunSpec): Promise<void> {
    const existing = this.runs.get(spec.mission.id);
    if (existing) return existing.done;
    const run = new MissionRun(spec, this.deps);
    const done = run.run().finally(() => this.runs.delete(spec.mission.id));
    this.runs.set(spec.mission.id, { run, done });
    return done;
  }

  pause(missionId: string): void {
    this.runs.get(missionId)?.run.pause();
  }

  resume(missionId: string): void {
    this.runs.get(missionId)?.run.resume();
  }

  stop(missionId: string): void {
    this.runs.get(missionId)?.run.stop();
  }

  isRunning(missionId: string): boolean {
    return this.runs.has(missionId);
  }

  async idle(): Promise<void> {
    await Promise.all([...this.runs.values()].map((entry) => entry.done));
  }
}
