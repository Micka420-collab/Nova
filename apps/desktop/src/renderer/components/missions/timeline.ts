// Mission timeline: a pure projection of `MissionEvent`s (the append-only log is the source of
// truth) into what the agent panel and the mission card show. Replaying the stored events of a
// mission rebuilds exactly the same view as following them live.
import {
  isMcpToolName,
  isTerminalMissionState,
  LIVE_ONLY_MISSION_EVENTS,
  type Approval,
  type Checkpoint,
  type IsolationLevel,
  type Mission,
  type MissionBudget,
  type MissionContract,
  type MissionDetail,
  type MissionEvent,
  type MissionFailureReason,
  type MissionPlanResult,
  type MissionSuspendReason,
  type MissionTask,
  type PermissionDecision,
  type Proof,
  type ReviewDecision,
  type ToolCallSummary,
  type ToolDisplay,
  type ToolName,
  type UsageSummary,
} from "@nova/shared";

/** Live output kept per tool card (the full output is an artifact in main). */
export const TOOL_OUTPUT_TAIL_CHARS = 4_000;

export type ToolItemState = "requested" | "waiting" | "running" | "succeeded" | "failed" | "cancelled" | "denied";

export interface ToolItem {
  kind: "tool";
  id: string;
  seq: number;
  at: number;
  call: ToolCallSummary;
  taskId: string | null;
  permission: PermissionDecision | null;
  approvalId: string | null;
  state: ToolItemState;
  isolationLevel: IsolationLevel | null;
  display: ToolDisplay | null;
  durationMs: number | null;
  /** Live stdout/stderr tail (`tool.output`), capped; empty once replayed from storage. */
  output: string;
}

export interface MessageItem {
  kind: "message";
  id: string;
  seq: number;
  at: number;
  text: string;
  complete: boolean;
  usage: UsageSummary | null;
}

export interface ApprovalItem {
  kind: "approval";
  id: string;
  seq: number;
  at: number;
  approval: Approval;
}

export type Notice =
  | { type: "plan"; summary: string; taskCount: number }
  | { type: "suspended"; reason: MissionSuspendReason; detail: string | null }
  | { type: "resumed" }
  | { type: "checkpoint"; checkpoint: Checkpoint }
  | { type: "proof"; proof: Proof }
  | { type: "review"; decisions: ReviewDecision[] };

export interface NoticeItem {
  kind: "notice";
  id: string;
  seq: number;
  at: number;
  notice: Notice;
}

export type TimelineItem = ToolItem | MessageItem | ApprovalItem | NoticeItem;

export type MissionOutcome =
  | { type: "succeeded"; summary: string; at: number }
  | { type: "failed"; reason: MissionFailureReason; detail: string | null; at: number }
  | { type: "cancelled"; by: "user" | "system"; at: number };

export interface MissionView {
  mission: Mission;
  contract: MissionContract | null;
  tasks: MissionTask[];
  planSummary: string | null;
  items: TimelineItem[];
  budget: MissionBudget | null;
  proofs: Proof[];
  checkpoints: Checkpoint[];
  outcome: MissionOutcome | null;
  review: ReviewDecision[] | null;
  suspended: { reason: MissionSuspendReason; detail: string | null } | null;
  /** Highest persisted event applied: older or repeated persisted events are ignored. */
  lastSeq: number;
}

function emptyView(mission: Mission, contract: MissionContract | null): MissionView {
  return {
    mission,
    contract,
    tasks: [],
    planSummary: null,
    items: [],
    budget: null,
    proofs: [],
    checkpoints: [],
    outcome: null,
    review: null,
    suspended: null,
    lastSeq: 0,
  };
}

function upsertTask(tasks: MissionTask[], task: MissionTask): MissionTask[] {
  const index = tasks.findIndex((item) => item.id === task.id);
  const next = index === -1 ? [...tasks, task] : tasks.map((item, i) => (i === index ? task : item));
  return next.toSorted((a, b) => a.seq - b.seq);
}

function mapTool(view: MissionView, callId: string, patch: (item: ToolItem) => ToolItem): MissionView {
  let found = false;
  const items = view.items.map((item) => {
    if (item.kind !== "tool" || item.id !== callId) return item;
    found = true;
    return patch(item);
  });
  return found ? { ...view, items } : view;
}

function withMission(view: MissionView, patch: Partial<Mission>, at: number): MissionView {
  return { ...view, mission: { ...view.mission, ...patch, updatedAt: Math.max(view.mission.updatedAt, at) } };
}

function hasOtherPendingApproval(view: MissionView, exceptId: string): boolean {
  return view.items.some((item) => item.kind === "approval" && item.id !== exceptId && item.approval.status === "pending");
}

function appendTail(current: string, chunk: string): string {
  const next = current + chunk;
  return next.length > TOOL_OUTPUT_TAIL_CHARS ? next.slice(next.length - TOOL_OUTPUT_TAIL_CHARS) : next;
}

function isLiveOnly(event: MissionEvent): boolean {
  return LIVE_ONLY_MISSION_EVENTS.includes(event.type);
}

/**
 * Applies one event. Returns the same object when the event changes nothing (duplicates, events of
 * an unknown mission that are not its creation), so React selectors stay stable.
 */
export function applyMissionEvent(view: MissionView | undefined, event: MissionEvent): MissionView | undefined {
  if (!view) {
    if (event.type !== "mission.created") return undefined;
    return { ...emptyView(event.mission, event.contract), lastSeq: event.seq };
  }
  const live = isLiveOnly(event);
  if (!live && event.seq <= view.lastSeq) return view;
  const next = reduce(view, event);
  return live ? next : { ...next, lastSeq: event.seq };
}

function reduce(view: MissionView, event: MissionEvent): MissionView {
  const base = { id: event.id, seq: event.seq, at: event.at };
  switch (event.type) {
    case "mission.created":
      return { ...view, mission: event.mission, contract: event.contract };
    case "mission.started":
      return withMission({ ...view, contract: event.contract }, { state: "running", startedAt: event.at }, event.at);
    case "mission.plan":
      return {
        ...view,
        planSummary: event.summary,
        tasks: event.tasks.toSorted((a, b) => a.seq - b.seq),
        items: [...view.items, { kind: "notice", ...base, notice: { type: "plan", summary: event.summary, taskCount: event.tasks.length } }],
      };
    case "task.updated":
      return { ...view, tasks: upsertTask(view.tasks, event.task) };
    case "tool.requested": {
      if (view.items.some((item) => item.kind === "tool" && item.id === event.call.id)) return view;
      const item: ToolItem = {
        kind: "tool",
        ...base,
        id: event.call.id,
        call: event.call,
        taskId: event.taskId,
        permission: null,
        approvalId: null,
        state: "requested",
        isolationLevel: null,
        display: null,
        durationMs: null,
        output: "",
      };
      return { ...view, items: [...view.items, item] };
    }
    case "tool.permission":
      return mapTool(view, event.callId, (item) => ({
        ...item,
        permission: event.decision,
        approvalId: event.approvalId,
        state:
          event.decision.decision === "deny"
            ? "denied"
            : event.decision.decision === "ask" && item.state === "requested"
              ? "waiting"
              : item.state,
      }));
    case "tool.started":
      return mapTool(view, event.callId, (item) => ({ ...item, state: "running", isolationLevel: event.isolationLevel }));
    case "tool.output":
      return mapTool(view, event.callId, (item) => ({ ...item, output: appendTail(item.output, event.chunk) }));
    case "tool.finished":
      return mapTool(view, event.callId, (item) => ({
        ...item,
        state: event.state,
        display: event.display,
        durationMs: event.durationMs,
      }));
    case "approval.requested": {
      const withItem: MissionView = view.items.some((item) => item.kind === "approval" && item.id === event.approval.id)
        ? view
        : { ...view, items: [...view.items, { kind: "approval", ...base, id: event.approval.id, approval: event.approval }] };
      const linked = event.approval.toolCallId
        ? mapTool(withItem, event.approval.toolCallId, (item) => ({ ...item, approvalId: event.approval.id, state: "waiting" }))
        : withItem;
      return withMission(linked, { state: "waiting_approval" }, event.at);
    }
    case "approval.resolved": {
      const items = view.items.map((item) =>
        item.kind === "approval" && item.id === event.approval.id ? { ...item, approval: event.approval } : item,
      );
      const resolved = { ...view, items };
      const stillWaiting = hasOtherPendingApproval(resolved, event.approval.id);
      if (stillWaiting || view.mission.state !== "waiting_approval") return resolved;
      return withMission(resolved, { state: "running" }, event.at);
    }
    case "message.delta": {
      const index = view.items.findIndex((item) => item.kind === "message" && item.id === event.messageId);
      if (index === -1) {
        const item: MessageItem = { kind: "message", ...base, id: event.messageId, text: event.text, complete: false, usage: null };
        return { ...view, items: [...view.items, item] };
      }
      const current = view.items[index];
      if (current?.kind !== "message" || current.complete) return view;
      const items = view.items.map((item, i) => (i === index ? { ...current, text: current.text + event.text } : item));
      return { ...view, items };
    }
    case "message.completed": {
      const message: MessageItem = {
        kind: "message",
        ...base,
        id: event.messageId,
        text: event.content,
        complete: true,
        usage: event.usage,
      };
      const index = view.items.findIndex((item) => item.kind === "message" && item.id === event.messageId);
      if (index === -1) return { ...view, items: [...view.items, message] };
      // Keep the position where the live text started.
      const current = view.items[index];
      const items = view.items.map((item, i) => (i === index ? { ...message, seq: current?.seq ?? event.seq, at: current?.at ?? event.at } : item));
      return { ...view, items };
    }
    case "proof.recorded":
      if (view.proofs.some((proof) => proof.id === event.proof.id)) return view;
      return {
        ...view,
        proofs: [...view.proofs, event.proof],
        items: [...view.items, { kind: "notice", ...base, notice: { type: "proof", proof: event.proof } }],
      };
    case "checkpoint.created":
      if (view.checkpoints.some((checkpoint) => checkpoint.id === event.checkpoint.id)) return view;
      return {
        ...view,
        checkpoints: [...view.checkpoints, event.checkpoint],
        items: [...view.items, { kind: "notice", ...base, notice: { type: "checkpoint", checkpoint: event.checkpoint } }],
      };
    case "budget.updated":
      return { ...view, budget: event.budget };
    case "mission.suspended":
      return withMission(
        {
          ...view,
          suspended: { reason: event.reason, detail: event.detail },
          items: [...view.items, { kind: "notice", ...base, notice: { type: "suspended", reason: event.reason, detail: event.detail } }],
        },
        { state: "suspended" },
        event.at,
      );
    case "mission.resumed":
      return withMission(
        { ...view, suspended: null, items: [...view.items, { kind: "notice", ...base, notice: { type: "resumed" } }] },
        { state: "running" },
        event.at,
      );
    case "mission.succeeded":
      if (view.outcome) return view;
      return withMission(
        { ...view, suspended: null, outcome: { type: "succeeded", summary: event.summary, at: event.at } },
        { state: "succeeded", endedAt: event.at },
        event.at,
      );
    case "mission.failed":
      if (view.outcome) return view;
      return withMission(
        { ...view, suspended: null, outcome: { type: "failed", reason: event.reason, detail: event.detail, at: event.at } },
        { state: "failed", endedAt: event.at },
        event.at,
      );
    case "mission.cancelled":
      if (view.outcome) return view;
      return withMission(
        { ...view, suspended: null, outcome: { type: "cancelled", by: event.by, at: event.at } },
        { state: "cancelled", endedAt: event.at },
        event.at,
      );
    case "review.decided":
      return {
        ...view,
        review: [...(view.review ?? []), ...event.decisions],
        items: [...view.items, { kind: "notice", ...base, notice: { type: "review", decisions: event.decisions } }],
      };
  }
}

/** Rebuilds the view of a mission from `missions.get` (stored events replayed in order). */
export function viewFromDetail(detail: MissionDetail): MissionView {
  let view: MissionView = { ...emptyView(detail.mission, detail.contract), tasks: detail.tasks };
  for (const event of detail.events.toSorted((a, b) => a.seq - b.seq)) {
    view = applyMissionEvent(view, event) ?? view;
  }
  // The stored projection is authoritative for what events may not carry (pages cut at 2 000).
  const proofs = [...view.proofs];
  for (const proof of detail.proofs) if (!proofs.some((item) => item.id === proof.id)) proofs.push(proof);
  return {
    ...view,
    mission: detail.mission,
    contract: detail.contract,
    tasks: detail.tasks.length > 0 ? detail.tasks.toSorted((a, b) => a.seq - b.seq) : view.tasks,
    budget: detail.budget,
    proofs,
  };
}

/** Merges events fetched with `afterSeq` into a view (reconnection, window reload). */
export function applyMissionEvents(view: MissionView, events: readonly MissionEvent[]): MissionView {
  return events.toSorted((a, b) => a.seq - b.seq).reduce((current, event) => applyMissionEvent(current, event) ?? current, view);
}

// ---------------------------------------------------------------------------
// Derived facts (never guessed: every number comes from a recorded event)

export type ToolCategory = "read" | "search" | "edit" | "terminal" | "git" | "web" | "mcp";

const TOOL_CATEGORIES: Record<Exclude<ToolName, `mcp__${string}__${string}`>, ToolCategory> = {
  read_file: "read",
  list_dir: "read",
  glob: "search",
  search_text: "search",
  write_file: "edit",
  edit_file: "edit",
  move_path: "edit",
  delete_path: "edit",
  run_command: "terminal",
  run_tests: "terminal",
  git_status: "git",
  git_diff: "git",
  git_commit: "git",
  web_search: "web",
  fetch_page: "web",
};

export function toolCategory(name: ToolName): ToolCategory {
  if (isMcpToolName(name)) return "mcp";
  return TOOL_CATEGORIES[name];
}

export interface FileTouch {
  path: string;
  change: "created" | "modified" | "moved" | "deleted";
  fromPath: string | null;
  additions: number;
  deletions: number;
  checkpointId: string | null;
}

export interface MissionFacts {
  files: FileTouch[];
  created: number;
  modified: number;
  deleted: number;
  moved: number;
  commands: number;
  toolCalls: number;
  failedTools: number;
  deniedTools: number;
  approvalsAsked: number;
  approvalsDenied: number;
  tokensIn: number;
  tokensOut: number;
  /** Messages whose usage or cost was not reported: token and cost sums are then lower bounds. */
  messagesWithoutUsage: number;
  webSearchCostUsd: number;
  webSearchesWithoutCost: number;
  /** Tasks proven by the runtime (state `verified`), and the others with their state. */
  verified: MissionTask[];
  unverified: MissionTask[];
}

/** Aggregates what a mission did, from its events only. */
export function missionFacts(view: MissionView): MissionFacts {
  const files = new Map<string, FileTouch>();
  let commands = 0;
  let toolCalls = 0;
  let failedTools = 0;
  let deniedTools = 0;
  let approvalsAsked = 0;
  let approvalsDenied = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  let messagesWithoutUsage = 0;
  let webSearchCostUsd = 0;
  let webSearchesWithoutCost = 0;
  for (const item of view.items) {
    if (item.kind === "tool") {
      toolCalls += 1;
      if (item.state === "failed") failedTools += 1;
      if (item.state === "denied") deniedTools += 1;
      const display = item.display;
      if (display?.kind === "file_change") {
        const previous = files.get(display.path);
        // A file created then edited by the same mission stays "created" for the user.
        const change = previous?.change === "created" && display.change === "modified" ? "created" : display.change;
        files.set(display.path, {
          path: display.path,
          change,
          fromPath: display.fromPath ?? previous?.fromPath ?? null,
          additions: (previous?.additions ?? 0) + display.additions,
          deletions: (previous?.deletions ?? 0) + display.deletions,
          checkpointId: previous?.checkpointId ?? display.checkpointId,
        });
      } else if (display?.kind === "command" || display?.kind === "tests") {
        commands += 1;
      } else if (display?.kind === "web_search") {
        if (display.costUsd === null) webSearchesWithoutCost += 1;
        else webSearchCostUsd += display.costUsd;
      }
    } else if (item.kind === "approval") {
      approvalsAsked += 1;
      if (item.approval.status === "denied") approvalsDenied += 1;
    } else if (item.kind === "message" && item.complete) {
      if (item.usage) {
        tokensIn += item.usage.promptTokens ?? 0;
        tokensOut += item.usage.completionTokens ?? 0;
        if (item.usage.cost === null || item.usage.promptTokens === null) messagesWithoutUsage += 1;
      } else {
        messagesWithoutUsage += 1;
      }
    }
  }
  const list = [...files.values()];
  return {
    files: list,
    created: list.filter((file) => file.change === "created").length,
    modified: list.filter((file) => file.change === "modified").length,
    deleted: list.filter((file) => file.change === "deleted").length,
    moved: list.filter((file) => file.change === "moved").length,
    commands,
    toolCalls,
    failedTools,
    deniedTools,
    approvalsAsked,
    approvalsDenied,
    tokensIn,
    tokensOut,
    messagesWithoutUsage,
    webSearchCostUsd,
    webSearchesWithoutCost,
    verified: view.tasks.filter((task) => task.state === "verified"),
    unverified: view.tasks.filter((task) => task.state !== "verified"),
  };
}

/** Proofs attached to a file: diff proofs of that path, and test/command proofs of tasks that wrote it. */
export function proofsForFile(view: MissionView, path: string): Proof[] {
  const taskIds = new Set(
    view.items.flatMap((item) =>
      item.kind === "tool" && item.display?.kind === "file_change" && item.display.path === path && item.taskId
        ? [item.taskId]
        : [],
    ),
  );
  return view.proofs.filter(
    (proof) => (proof.kind === "test" || proof.kind === "command") && proof.taskId !== null && taskIds.has(proof.taskId),
  );
}

/** Index (0-based) of the task in progress, else of the first task not done; null without tasks. */
export function currentTaskIndex(view: MissionView): number | null {
  if (view.tasks.length === 0) return null;
  const running = view.tasks.findIndex((task) => task.state === "running");
  if (running !== -1) return running;
  const todo = view.tasks.findIndex((task) => task.state === "todo" || task.state === "blocked");
  return todo === -1 ? view.tasks.length - 1 : todo;
}

export function pendingApprovals(view: MissionView): Approval[] {
  return view.items.flatMap((item) => (item.kind === "approval" && item.approval.status === "pending" ? [item.approval] : []));
}

export function isMissionActive(view: MissionView): boolean {
  return !isTerminalMissionState(view.mission.state);
}

/** Tool items grouped for display: runs of more than three consecutive calls of one category fold. */
export type TimelineEntry =
  | { kind: "item"; item: TimelineItem }
  | { kind: "group"; category: ToolCategory; items: ToolItem[] };

export const GROUP_MIN_RUN = 4;

export function groupTimeline(items: readonly TimelineItem[]): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  let run: ToolItem[] = [];
  const flush = () => {
    if (run.length >= GROUP_MIN_RUN) {
      const first = run[0];
      if (first) entries.push({ kind: "group", category: toolCategory(first.call.name), items: run });
    } else {
      for (const item of run) entries.push({ kind: "item", item });
    }
    run = [];
  };
  for (const item of items) {
    const sameRun =
      item.kind === "tool" &&
      item.state !== "failed" &&
      run.length > 0 &&
      run[0] !== undefined &&
      toolCategory(run[0].call.name) === toolCategory(item.call.name);
    if (item.kind === "tool" && item.state !== "failed" && (run.length === 0 || sameRun)) {
      run.push(item);
      continue;
    }
    flush();
    if (item.kind === "tool" && item.state !== "failed") run.push(item);
    else entries.push({ kind: "item", item });
  }
  flush();
  return entries;
}

/** View of a mission just planned (state `ready`): its tasks and summary, before any event. */
export function viewFromPlan(result: MissionPlanResult): MissionView {
  return {
    ...emptyView(result.mission, result.contract),
    tasks: result.tasks.toSorted((a, b) => a.seq - b.seq),
    planSummary: result.summary,
  };
}

/** Applies a decided approval returned by `approvals.decide` (its event may arrive later). */
export function withApproval(view: MissionView, approval: Approval): MissionView {
  let changed = false;
  const items = view.items.map((item) => {
    if (item.kind !== "approval" || item.id !== approval.id) return item;
    changed = true;
    return { ...item, approval };
  });
  return changed ? { ...view, items } : view;
}
