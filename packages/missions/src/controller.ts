// Mission controller (main side): the `missions.*` IPC group, the budget gate used by the
// provider proxy, the tool gateway and the runtime link. Pure over injected stores and gates, so
// it is tested without Electron; apps/desktop wires it (services/missions-service.ts).
import {
  DEFAULT_MISSION_BUDGET_USD,
  DEFAULT_MISSION_MAX_DURATION_MS,
  OPERATION_CLASSES,
  isTerminalMissionState,
  type Checkpoint,
  type CheckpointsListRequest,
  type IsolationLevel,
  type Mission,
  type MissionBudget,
  type MissionContract,
  type MissionContractInput,
  type MissionDetail,
  type MissionEvent,
  type MissionGetRequest,
  type MissionIdRequest,
  type MissionPage,
  type MissionPlanRequest,
  type MissionPlanResult,
  type MissionStartRequest,
  type MissionState,
  type MissionTask,
  type MissionsListRequest,
  type OperationClass,
  type PermissionProfile,
  type Proof,
  type ReviewDecideRequest,
  type ReviewResult,
  type UsageSummary,
  type WorkMode,
  type WorkspaceFacts,
} from "@nova/shared";
import type { CommandRunner, McpToolOffer, ToolRegistry } from "@nova/tools";
import { estimateMission, type PricingLike } from "./budget";
import { createToolGateway, type ApprovalGate, type CheckpointGate, type MissionToolContext, type PermissionGate, type ToolGatewayDeps } from "./gateway";
import { missionToolSet } from "./tool-set";
import type { MissionEventInput, ProviderProxy, ToolGateway } from "./index";
import { createMissionJournal, eventFromRecord, type MissionEventRecordLike, type MissionJournal } from "./journal";
import { planMission } from "./planner";
import { applyReview, buildReview, type ReviewFsGate, type ReviewModel } from "./review";
import type { MainRuntimeHandlers, RuntimeLink } from "./runtime-link";

// ---------------------------------------------------------------------------
// Store shape (structurally satisfied by @nova/storage `createMissionRepo`)

export interface MissionContractRecordLike {
  profile: PermissionProfile;
  isolationLevel: IsolationLevel;
  allowedOperations: OperationClass[];
  allowedHosts: string[];
  maxDurationMs: number | null;
  budgetUsd: number | null;
}

export interface MissionRecordLike extends Mission {
  contract: (MissionContractRecordLike & { createdAt: number }) | null;
}

export interface MissionStoreLike {
  create(input: {
    workspaceId: string;
    conversationId: string | null;
    title: string;
    goal: string;
    mode: WorkMode;
    modelId: string | null;
    contract: MissionContractRecordLike;
  }): MissionRecordLike;
  get(id: string): MissionRecordLike | null;
  appendEvent(missionId: string, type: string, payload: unknown): MissionEventRecordLike;
  listEvents(missionId: string, afterSeq?: number): MissionEventRecordLike[];
  listRecentEvents(missionId: string, limit: number): MissionEventRecordLike[];
  setState(id: string, state: MissionState, stamps?: { startedAt?: number; endedAt?: number }): unknown;
  updateContract(id: string, contract: MissionContractRecordLike): void;
  list(workspaceId: string | null, limit: number): { items: MissionRecordLike[]; hasMore: boolean };
  listInterrupted(): MissionRecordLike[];
  replaceTasks(missionId: string, drafts: { title: string; acceptance: MissionTask["acceptance"] }[]): (MissionTask & { updatedAt: number })[];
  listTasks(missionId: string): (MissionTask & { updatedAt: number })[];
  setTaskState(taskId: string, state: MissionTask["state"]): unknown;
  toolCalls: ToolGatewayDeps["toolCalls"];
  proofs: { insert: ToolGatewayDeps["proofs"]["insert"]; listByMission(missionId: string): Proof[] };
  cost: {
    reserve(input: { missionId: string; amountUsd: number; missionBudgetUsd: number | null; dailyLimitUsd: number | null; dayStart: number }):
      | { ok: true; reservation: { id: string } }
      | { ok: false; reason: "budget" | "daily_budget"; availableUsd: number };
    settle(reservationId: string, actualUsd: number | null): void;
    release(reservationId: string): void;
    releaseOpen(missionId: string): void;
    recordUsage(input: {
      missionId: string;
      toolCallId: string | null;
      kind: "generation" | "web_search";
      providerId: string;
      modelId: string;
      servedModel: string | null;
      servedProvider: string | null;
      promptTokens: number | null;
      completionTokens: number | null;
      reasoningTokens: number | null;
      cachedTokens: number | null;
      cost: number | null;
    }): void;
    summary(missionId: string, dayStart: number): { reservedUsd: number; spentUsd: number; unknownCostCalls: number; dailySpentUsd: number };
  };
  reviews: { record(missionId: string, decisions: { path: string; hunkIndex: number | null; decision: "kept" | "reverted" }[]): void };
}

/**
 * What is left under a cap, French notation, rounded DOWN (never promise more than there is), with
 * four decimals under one cent (a 0,002 $ cap is not « 0,00 $ »).
 */
function remainingUsdText(usd: number): string {
  const digits = usd > 0 && usd < 0.01 ? 4 : 2;
  const factor = 10 ** digits;
  // The epsilon absorbs float noise (0.002 − 0.0016 = 0.000399…): rounding down, not losing a unit.
  return (Math.floor(usd * factor + 1e-6) / factor).toFixed(digits).replace(".", ",");
}

/** Expected refusal with an IPC error code (main maps it to ServiceError). */
export class MissionError extends Error {
  constructor(
    readonly code: "invalid_request" | "not_found" | "conflict" | "unavailable" | "provider",
    message: string,
  ) {
    super(message);
    this.name = "MissionError";
  }
}

export interface MissionControllerDeps {
  store: MissionStoreLike;
  /** Pushes every accepted event to the renderer (`missions.onEvent`). */
  push(event: MissionEvent): void;
  /** In-process provider access for planning (main side of the proxy, key added there). */
  proxy: ProviderProxy;
  /** The agent-runtime link, started on first use. */
  runtime(): Promise<RuntimeLink>;
  workspaces: { get(id: string): { id: string; permissionProfile: PermissionProfile } | null };
  facts?(workspaceId: string): Promise<WorkspaceFacts | null>;
  /** Registry of one mission (built-ins over the injected APIs + enabled MCP tools snapshot). */
  tools(input: { workspaceId: string; missionId: string }): Promise<{ registry: ToolRegistry; mcpTools: readonly McpToolOffer[] }>;
  commands: Pick<CommandRunner, "stopAll"> | null;
  permissions: PermissionGate;
  approvals: ApprovalGate;
  checkpoints: (CheckpointGate & { list(req: CheckpointsListRequest): Promise<Checkpoint[]> }) | null;
  reviewFs: ReviewFsGate | null;
  isolationLevel(): IsolationLevel;
  pricing(modelId: string): PricingLike | null;
  /** Catalog capability; null = unknown (then the call is attempted). */
  supportsTools(modelId: string): boolean | null;
  dailyLimitUsd: number;
  audit?: ToolGatewayDeps["audit"];
  auditDecision?: ToolGatewayDeps["auditDecision"];
  now?: () => number;
  /** Bound on waiting for the runtime's terminal event after a stop. */
  stopTimeoutMs?: number;
}

export interface MissionController {
  plan(req: MissionPlanRequest): Promise<MissionPlanResult>;
  start(req: MissionStartRequest): Promise<Mission>;
  pause(req: MissionIdRequest): Promise<Mission>;
  /**
   * `budgetUsd` (in-process until the IPC contract carries it) raises the mission budget before
   * resuming a mission suspended at its cap; it can only go up.
   */
  resume(req: MissionIdRequest & { budgetUsd?: number }): Promise<Mission>;
  stop(req: MissionIdRequest): Promise<Mission>;
  list(req: MissionsListRequest): Promise<MissionPage>;
  get(req: MissionGetRequest): Promise<MissionDetail>;
  review(req: ReviewDecideRequest): Promise<ReviewResult>;
  /** Budget gate used by the provider proxy before/after each paid call. */
  budget: {
    reserve(missionId: string, estimateUsd: number | null): { ok: true; reservationId: string } | { ok: false; code: "budget" | "daily_budget"; message: string };
    settle(missionId: string, reservationId: string, report: { modelId: string; servedModel: string | null; servedProvider: string | null; usage: UsageSummary | null }): void;
    release(missionId: string, reservationId: string): void;
  };
  /** Handlers for `connectRuntime` (model stream is main's provider proxy). */
  runtimeHandlers(streamModel: MainRuntimeHandlers["streamModel"]): MainRuntimeHandlers;
  gateway: ToolGateway;
  journal: MissionJournal;
  /** Marks missions left running by a previous process as failed (call once at startup). */
  recoverInterrupted(): number;
  isRunning(missionId: string): boolean;
  /** Contract of a mission (L1 `PermissionsService.contractOf`); null when unknown. */
  contractOf(missionId: string): MissionContract | null;
  /** A11: files the mission changed, before/after hashes, from its restore points. */
  reviewModel(missionId: string): Promise<ReviewModel>;
}

const MAX_EVENTS = 2_000;
/**
 * Restore points read for a mission's review: all of them (40 iterations × 32 calls, plus review
 * and restore safety points, stay far below). A review built from part of the history would take
 * an intermediate state for "before" and revert only part of the mission.
 */
const MAX_REVIEW_CHECKPOINTS = 20_000;

function toMission(record: MissionRecordLike): Mission {
  const { contract: _contract, ...mission } = record;
  return mission;
}

function startOfDay(time: number): number {
  const date = new Date(time);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function titleOf(goal: string): string {
  const line = goal.split(/\r?\n/).map((part) => part.trim()).find(Boolean) ?? "Mission";
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

const PROFILE_OPERATIONS: Record<PermissionProfile, readonly OperationClass[]> = {
  read_only: ["read", "network"],
  assisted: OPERATION_CLASSES,
  autonomous: OPERATION_CLASSES,
  custom: OPERATION_CLASSES,
};

export function createMissionController(deps: MissionControllerDeps): MissionController {
  const now = deps.now ?? Date.now;
  const stopTimeoutMs = deps.stopTimeoutMs ?? 5_000;
  const running = new Map<string, MissionToolContext>();
  /** Ends a mission's main-side work: its pending approvals expire, its running tools stop. */
  const lifetimes = new Map<string, AbortController>();
  /** Gateway calls still in flight per mission: their end is journaled before the mission's. */
  const inFlight = new Map<string, Set<Promise<unknown>>>();
  const terminalWaiters = new Map<string, (() => void)[]>();
  let link: RuntimeLink | null = null;

  const journal = createMissionJournal({
    store: deps.store,
    push: deps.push,
    now,
    onTerminal(event) {
      const missionId = event.missionId;
      lifetimes.get(missionId)?.abort();
      lifetimes.delete(missionId);
      running.delete(missionId);
      deps.store.cost.releaseOpen(missionId);
      void deps.commands?.stopAll(missionId).catch(() => undefined);
      queueMicrotask(() => emitBudget(missionId));
      for (const waiter of terminalWaiters.get(missionId) ?? []) waiter();
      terminalWaiters.delete(missionId);
    },
  });
  const append = (event: MissionEventInput): MissionEvent | null => {
    const stored = journal.append(event);
    // The tasks table is the projection read by `missions.get`: keep it in step with the journal.
    if (stored?.type === "task.updated") deps.store.setTaskState(stored.task.id, stored.task.state);
    return stored;
  };

  /**
   * S6 after a crash: every call left without its end gets one, before the mission's terminal event
   * (else it reads « en cours » forever). A call that had started may have acted: `interrupted`,
   * result unknown, shown to the user and never replayed. One that had not started was not run.
   */
  const closeOpenToolCalls = (missionId: string): void => {
    const events = deps.store.listEvents(missionId).map(eventFromRecord);
    // An approval nobody can answer any more (its call is gone) reads « en attente » forever otherwise.
    const decided = new Set(events.flatMap((event) => (event.type === "approval.resolved" ? [event.approval.id] : [])));
    for (const event of events) {
      if (event.type !== "approval.requested" || decided.has(event.approval.id)) continue;
      append({ type: "approval.resolved", missionId, approval: { ...event.approval, status: "expired", decidedAt: now() } });
    }
    const ended = new Set(events.flatMap((event) => (event.type === "tool.finished" ? [event.callId] : [])));
    const started = new Set(events.flatMap((event) => (event.type === "tool.started" ? [event.callId] : [])));
    for (const event of events) {
      if (event.type !== "tool.requested" || ended.has(event.call.id)) continue;
      const ran = started.has(event.call.id);
      const display = ran
        ? { kind: "error" as const, code: "interrupted" as const, message: "NOVA stopped while this call was running: its outcome is unknown. Do not assume it ran or not; it was not retried." }
        : { kind: "error" as const, code: "cancelled" as const, message: "NOVA stopped before this call ran: it was not executed." };
      deps.store.toolCalls.finish(event.call.id, ran ? "failed" : "cancelled", { exitCode: null, resultSummary: display.code });
      append({ type: "tool.finished", missionId, callId: event.call.id, state: ran ? "failed" : "cancelled", display, durationMs: Math.max(0, now() - event.at) });
    }
  };

  const mission = (id: string): MissionRecordLike => {
    const record = deps.store.get(id);
    if (!record) throw new MissionError("not_found", "mission not found");
    return record;
  };

  /** The full contract is journaled (the table has no web search column); latest wins. */
  const storedContract = (record: MissionRecordLike): MissionContract => {
    const events = deps.store.listEvents(record.id).map(eventFromRecord);
    for (const event of events.reverse()) {
      if (event.type === "mission.started" || event.type === "mission.created") return event.contract;
    }
    const stored = record.contract;
    return {
      workspaceId: record.workspaceId,
      mode: record.mode,
      profile: stored?.profile ?? "assisted",
      isolationLevel: stored?.isolationLevel ?? "L0",
      allowedOperations: stored?.allowedOperations ?? [],
      allowedHosts: stored?.allowedHosts ?? [],
      webSearch: false,
      maxDurationMs: stored?.maxDurationMs ?? DEFAULT_MISSION_MAX_DURATION_MS,
      budgetUsd: stored?.budgetUsd ?? DEFAULT_MISSION_BUDGET_USD,
    };
  };

  const buildContract = (workspaceId: string, mode: WorkMode, profile: PermissionProfile, input: MissionContractInput | null): MissionContract => ({
    workspaceId,
    mode,
    profile: input?.profile ?? profile,
    isolationLevel: deps.isolationLevel(),
    allowedOperations: input?.allowedOperations ?? [...PROFILE_OPERATIONS[input?.profile ?? profile]],
    allowedHosts: input?.allowedHosts ?? [],
    webSearch: input?.webSearch ?? mode !== "discuss",
    maxDurationMs: input?.maxDurationMs ?? DEFAULT_MISSION_MAX_DURATION_MS,
    budgetUsd: input?.budgetUsd ?? DEFAULT_MISSION_BUDGET_USD,
  });

  const contractRecord = (contract: MissionContract): MissionContractRecordLike => ({
    profile: contract.profile,
    isolationLevel: contract.isolationLevel,
    allowedOperations: contract.allowedOperations,
    allowedHosts: contract.allowedHosts,
    maxDurationMs: contract.maxDurationMs,
    budgetUsd: contract.budgetUsd,
  });

  const budgetOf = (missionId: string): MissionBudget => {
    const summary = deps.store.cost.summary(missionId, startOfDay(now()));
    const record = deps.store.get(missionId);
    return {
      budgetUsd: running.get(missionId)?.contract.budgetUsd ?? record?.contract?.budgetUsd ?? DEFAULT_MISSION_BUDGET_USD,
      reservedUsd: summary.reservedUsd,
      spentUsd: summary.spentUsd,
      unknownCostCalls: summary.unknownCostCalls,
      dailySpentUsd: summary.dailySpentUsd,
      dailyLimitUsd: deps.dailyLimitUsd,
    };
  };

  function emitBudget(missionId: string): void {
    append({ type: "budget.updated", missionId, budget: budgetOf(missionId) });
  }

  const waitForTerminal = (missionId: string, timeoutMs: number): Promise<void> =>
    new Promise((resolve) => {
      if (journal.isTerminated(missionId)) {
        resolve();
        return;
      }
      const timer = setTimeout(resolve, timeoutMs);
      terminalWaiters.set(missionId, [...(terminalWaiters.get(missionId) ?? []), () => {
        clearTimeout(timer);
        resolve();
      }]);
    });

  /**
   * Main ends a mission the runtime cannot end (gone, or silent after a stop): its main-side work
   * is aborted and awaited (bounded) so each call's end and each approval's outcome is journaled
   * BEFORE the terminal event, which closes the journal; whatever is still open is closed then.
   */
  async function endFromMain(missionId: string, terminal: MissionEventInput): Promise<void> {
    lifetimes.get(missionId)?.abort();
    const calls = [...(inFlight.get(missionId) ?? [])];
    if (calls.length > 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, stopTimeoutMs);
        void Promise.allSettled(calls).then(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    if (journal.isTerminated(missionId)) return;
    closeOpenToolCalls(missionId);
    append(terminal);
  }

  async function runtimeLink(): Promise<RuntimeLink> {
    const next = await deps.runtime();
    if (next !== link) {
      link = next;
      // A runtime that dies takes its missions with it: each ends failed, exactly once.
      void next.closed.then(() => {
        if (link === next) link = null;
        for (const missionId of [...running.keys()]) {
          void endFromMain(missionId, { type: "mission.failed", missionId, reason: "internal", detail: "le runtime de l'agent s'est arrêté" });
        }
      });
    }
    return next;
  }

  const toolGateway = createToolGateway({
    context: (missionId) => running.get(missionId) ?? null,
    permissions: deps.permissions,
    approvals: deps.approvals,
    checkpoints: deps.checkpoints,
    journal: { append },
    toolCalls: deps.store.toolCalls,
    proofs: deps.store.proofs,
    ...(deps.audit ? { audit: deps.audit } : {}),
    ...(deps.auditDecision ? { auditDecision: deps.auditDecision } : {}),
    now,
  });
  const gateway: ToolGateway = {
    run(request, signal) {
      const call = toolGateway.run(request, signal);
      const calls = inFlight.get(request.missionId) ?? new Set();
      inFlight.set(request.missionId, calls.add(call));
      void call.finally(() => {
        calls.delete(call);
        if (calls.size === 0 && inFlight.get(request.missionId) === calls) inFlight.delete(request.missionId);
      });
      return call;
    },
  };

  const missionCheckpoints = async (record: MissionRecordLike, checkpoints: NonNullable<MissionControllerDeps["checkpoints"]>): Promise<Checkpoint[]> => {
    const list = await checkpoints.list({ workspaceId: record.workspaceId, missionId: record.id, limit: MAX_REVIEW_CHECKPOINTS + 1 });
    if (list.length > MAX_REVIEW_CHECKPOINTS) throw new MissionError("unavailable", "too many restore points to review this mission");
    return list;
  };

  const summaryOf = (missionId: string): string => {
    const events = deps.store.listEvents(missionId).map(eventFromRecord);
    const plan = events.reverse().find((event) => event.type === "mission.plan");
    return plan?.type === "mission.plan" ? plan.summary : "";
  };

  const controller: MissionController = {
    gateway,
    journal,
    isRunning: (missionId) => running.has(missionId),

    async plan(req) {
      const workspace = deps.workspaces.get(req.workspaceId);
      if (!workspace) throw new MissionError("not_found", "workspace not found");
      if (deps.supportsTools(req.modelId) === false && req.mode !== "discuss") {
        throw new MissionError("invalid_request", "this model does not support tool calling");
      }
      const contract = buildContract(workspace.id, req.mode, workspace.permissionProfile, req.contract);
      const created = deps.store.create({
        workspaceId: workspace.id,
        conversationId: req.conversationId,
        title: titleOf(req.goal),
        goal: req.goal,
        mode: req.mode,
        modelId: req.modelId,
        contract: contractRecord(contract),
      });
      append({ type: "mission.created", missionId: created.id, mission: toMission(created), contract });
      const facts = (await deps.facts?.(workspace.id).catch(() => null)) ?? null;
      let plan;
      try {
        plan = await planMission({
          proxy: deps.proxy,
          missionId: created.id,
          modelId: req.modelId,
          goal: req.goal,
          mode: req.mode,
          facts,
          signal: new AbortController().signal,
        });
      } catch (error) {
        const code = typeof (error as { code?: unknown })?.code === "string" ? String((error as { code: string }).code) : "provider_error";
        append({ type: "mission.failed", missionId: created.id, reason: "provider_error", detail: `plan impossible (${code})` });
        throw new MissionError(code === "budget" || code === "daily_budget" ? "conflict" : "provider", `planning failed: ${code}`);
      }
      const tasks = deps.store.replaceTasks(created.id, plan.tasks).map(({ updatedAt: _updatedAt, ...task }) => task);
      append({ type: "mission.plan", missionId: created.id, summary: plan.summary, tasks });
      const estimate = estimateMission({
        taskCount: tasks.length,
        basePromptTokens: 3_000 + Math.ceil(req.goal.length / 4),
        pricing: deps.pricing(req.modelId),
      });
      return { mission: toMission(mission(created.id)), contract, tasks, summary: plan.summary, estimate };
    },

    async start(req) {
      const record = mission(req.missionId);
      if (record.state !== "ready") throw new MissionError("conflict", `mission is ${record.state}`);
      const workspace = deps.workspaces.get(record.workspaceId);
      if (!workspace) throw new MissionError("not_found", "workspace not found");
      if (!record.modelId) throw new MissionError("invalid_request", "mission has no model");
      const contract = buildContract(record.workspaceId, record.mode, workspace.permissionProfile, req.contract);
      deps.store.updateContract(record.id, contractRecord(contract));
      let tasks: MissionTask[];
      if (req.tasks) {
        tasks = deps.store.replaceTasks(record.id, req.tasks).map(({ updatedAt: _updatedAt, ...task }) => task);
        append({ type: "mission.plan", missionId: record.id, summary: summaryOf(record.id), tasks });
      } else {
        tasks = deps.store.listTasks(record.id).map(({ updatedAt: _updatedAt, ...task }) => task);
      }
      const { registry, mcpTools } = await deps.tools({ workspaceId: record.workspaceId, missionId: record.id });
      const allowedTools = missionToolSet(record.mode, { webSearch: contract.webSearch, mcpTools });
      const tools = registry.definitions(allowedTools);
      const lifetime = new AbortController();
      lifetimes.set(record.id, lifetime);
      running.set(record.id, {
        workspaceId: record.workspaceId,
        missionId: record.id,
        mode: record.mode,
        contract,
        allowedTools,
        registry,
        seenVersions: new Map(),
        tainted: false,
        signal: lifetime.signal,
      });
      append({ type: "mission.started", missionId: record.id, contract });
      emitBudget(record.id);
      try {
        const runtime = await runtimeLink();
        await runtime.start({ mission: toMission(mission(record.id)), contract, tasks, tools, planSummary: summaryOf(record.id) });
      } catch {
        append({ type: "mission.failed", missionId: record.id, reason: "internal", detail: "le runtime de l'agent est indisponible" });
        throw new MissionError("unavailable", "agent runtime unavailable");
      }
      return toMission(mission(record.id));
    },

    async pause(req) {
      const record = mission(req.missionId);
      if (isTerminalMissionState(record.state)) throw new MissionError("conflict", `mission is ${record.state}`);
      if (running.has(record.id) && record.state !== "suspended") link?.pause(record.id);
      return toMission(record);
    },

    async resume(req) {
      const record = mission(req.missionId);
      if (record.state !== "suspended" && record.state !== "running" && record.state !== "waiting_approval") {
        throw new MissionError("conflict", `mission is ${record.state}`);
      }
      const context = running.get(record.id);
      if (!context) throw new MissionError("conflict", "mission is not running in this session");
      if (req.budgetUsd !== undefined) {
        if (!(req.budgetUsd >= context.contract.budgetUsd) || req.budgetUsd > 1_000) {
          throw new MissionError("invalid_request", "the budget can only be raised (at most 1 000 $)");
        }
        context.contract = { ...context.contract, budgetUsd: req.budgetUsd };
        deps.store.updateContract(record.id, contractRecord(context.contract));
        emitBudget(record.id);
      }
      link?.resume(record.id);
      return toMission(record);
    },

    async stop(req) {
      const record = mission(req.missionId);
      if (isTerminalMissionState(record.state) || journal.isTerminated(record.id)) return toMission(record);
      if (running.has(record.id) && link) {
        link.stop(record.id);
        await deps.commands?.stopAll(record.id).catch(() => undefined);
        await waitForTerminal(record.id, stopTimeoutMs);
      }
      // Not started, runtime gone, or no answer in time: main closes it (the journal drops duplicates).
      await endFromMain(record.id, { type: "mission.cancelled", missionId: record.id, by: "user" });
      running.delete(record.id);
      return toMission(mission(record.id));
    },

    async list(req) {
      const page = deps.store.list(req.workspaceId, req.limit);
      return { items: page.items.map(toMission), hasMore: page.hasMore };
    },

    async get(req) {
      const record = mission(req.missionId);
      const records = req.afterSeq > 0 ? deps.store.listEvents(record.id, req.afterSeq).slice(-MAX_EVENTS) : deps.store.listRecentEvents(record.id, MAX_EVENTS);
      return {
        mission: toMission(record),
        contract: running.get(record.id)?.contract ?? storedContract(record),
        tasks: deps.store.listTasks(record.id).map(({ updatedAt: _updatedAt, ...task }) => task),
        proofs: deps.store.proofs.listByMission(record.id),
        budget: budgetOf(record.id),
        events: records.map(eventFromRecord),
      };
    },

    async review(req) {
      const record = mission(req.missionId);
      if (!isTerminalMissionState(record.state)) throw new MissionError("conflict", "review happens after the mission ends");
      if (!deps.checkpoints || !deps.reviewFs) throw new MissionError("unavailable", "review needs restore points");
      const checkpoints = await missionCheckpoints(record, deps.checkpoints);
      const result = await applyReview({ workspaceId: record.workspaceId, missionId: record.id, model: buildReview(checkpoints), decisions: req.decisions, fs: deps.reviewFs });
      if (result.applied.length > 0) {
        deps.store.reviews.record(record.id, result.applied);
        append({ type: "review.decided", missionId: record.id, decisions: result.applied });
      }
      return result;
    },

    budget: {
      reserve(missionId, estimateUsd) {
        const record = deps.store.get(missionId);
        if (!record) return { ok: false, code: "budget", message: "unknown mission" };
        const budgetUsd = running.get(missionId)?.contract.budgetUsd ?? record.contract?.budgetUsd ?? DEFAULT_MISSION_BUDGET_USD;
        // An unknown price reserves nothing up front; the reported cost still counts afterwards.
        const result = deps.store.cost.reserve({
          missionId,
          amountUsd: estimateUsd ?? 0,
          missionBudgetUsd: budgetUsd,
          dailyLimitUsd: deps.dailyLimitUsd,
          dayStart: startOfDay(now()),
        });
        if (result.ok) return { ok: true, reservationId: result.reservation.id };
        const left = remainingUsdText(result.availableUsd);
        return {
          ok: false,
          code: result.reason,
          message: result.reason === "budget" ? `budget de la mission atteint (reste ${left} $)` : `budget du jour atteint (reste ${left} $)`,
        };
      },
      settle(missionId, reservationId, report) {
        deps.store.cost.settle(reservationId, report.usage?.cost ?? null);
        deps.store.cost.recordUsage({
          missionId,
          toolCallId: null,
          kind: "generation",
          providerId: "openrouter",
          modelId: report.modelId,
          servedModel: report.servedModel,
          servedProvider: report.servedProvider,
          promptTokens: report.usage?.promptTokens ?? null,
          completionTokens: report.usage?.completionTokens ?? null,
          reasoningTokens: report.usage?.reasoningTokens ?? null,
          cachedTokens: report.usage?.cachedTokens ?? null,
          cost: report.usage?.cost ?? null,
        });
        emitBudget(missionId);
      },
      release(_missionId, reservationId) {
        deps.store.cost.release(reservationId);
      },
    },

    runtimeHandlers(streamModel) {
      return {
        streamModel,
        gateway,
        appendEvent: (event) => void append(event),
        isRunning: (missionId) => running.has(missionId),
      };
    },

    contractOf(missionId) {
      const context = running.get(missionId);
      if (context) return context.contract;
      const record = deps.store.get(missionId);
      return record ? storedContract(record) : null;
    },

    async reviewModel(missionId) {
      const record = mission(missionId);
      if (!deps.checkpoints) return { files: [] };
      return buildReview(await missionCheckpoints(record, deps.checkpoints));
    },

    recoverInterrupted() {
      const interrupted = deps.store.listInterrupted();
      for (const record of interrupted) {
        deps.store.cost.releaseOpen(record.id);
        closeOpenToolCalls(record.id);
        append({ type: "mission.failed", missionId: record.id, reason: "internal", detail: "interrompue par l'arrêt de NOVA" });
      }
      return interrupted.length;
    },
  };
  return controller;
}
