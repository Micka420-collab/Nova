// L5 (A14 bounded) — sub-missions: depth 1, budget reserved from the parent, git worktree for a
// writing child, serialized integration after tests. Main side: backs `ToolDeps.submissions`
// (start_submission) and the `submissions.*` IPC group (storage: mission_links).
//
// Invariants:
// - depth 1: a sub-mission never delegates (its contract has no sub-missions, and `start` refuses a
//   parent that is itself a sub-mission); at most `maxChildren` per parent (contract, capped by
//   SUBMISSION_LIMITS) and `maxParallel` running at once;
// - shared budget: the child's budget is RESERVED on the parent before anything is spent (refused
//   when it does not fit) and, when the child ends, the reservation is replaced by the child's real
//   cost; the child spends against that budget only (its own contract). The hold is not counted in
//   the day's total: the child's own calls are;
// - the child's contract is a subset of the parent's (./contract);
// - a child that writes works in `<dataDir>/worktrees/<childId>`; nothing it does reaches the
//   project until the user asks to integrate it. Integration is serialized (one at a time), runs the
//   project's tests on the worktree first, refuses on any file the user changed since the child
//   started (`conflict`, nothing overwritten), and writes through the project's file API under one
//   restore point, each path evaluated by the permission engine before anything is written;
// - the worktree is removed once integrated, discarded or found empty (no residue; `recover` also
//   removes leftovers at startup).
import { createHash } from "node:crypto";
import {
  SUBMISSION_LIMITS,
  isTerminalMissionState,
  missionHarnessOf,
  type Mission,
  type MissionContract,
  type MissionEvent,
  type MissionIdRequest,
  type MissionLink,
  type MissionLinkKind,
  type MissionPlanRequest,
  type MissionPlanResult,
  type MissionStartRequest,
  type MissionState,
  type MissionTreeNode,
  type PermissionDecision,
  type PermissionRequest,
  type RelativePath,
  type SubMissionIntegration,
  type WorkMode,
} from "@nova/shared";
import type { SubMissionStart, SubmissionsApi, WorkspaceFileApi } from "@nova/tools";
import type { MissionEventInput } from "../index";
import { childContractInput } from "./contract";

export { childContractInput, isNarrowerContract, type ChildContractOutcome } from "./contract";

export interface SubmissionsController extends SubmissionsApi {
  tree(missionId: string): Promise<MissionTreeNode>;
  /** One integration at a time (queue); runs the child's tests on its worktree first. */
  integrate(childMissionId: string): Promise<MissionTreeNode>;
  discard(childMissionId: string): Promise<MissionTreeNode>;
  /** Feed every accepted mission event (child ends, parent cancelled). */
  onMissionEvent(event: MissionEvent): void;
  /** Workspace root the tools of `missionId` must use: its worktree for a writing child, else null. */
  workspaceRootOf(missionId: string): Promise<string | null>;
  /** Startup: settles children left open by a crash and removes worktree leftovers. After `recoverInterrupted`. */
  recover(): Promise<void>;
  /** Children still running (activity counters, exit warning). */
  readonly activeCount: number;
}

/** Expected refusal (codes are IPC error codes; main maps them to ServiceError). */
export class SubmissionError extends Error {
  constructor(
    readonly code: "invalid_request" | "not_found" | "conflict" | "unavailable" | "provider",
    message: string,
  ) {
    super(message);
    this.name = "SubmissionError";
  }
}

// ---------------------------------------------------------------------------
// Injected dependencies (structural; wired by apps/desktop submissions-service)

/** @nova/storage `MissionLinkRepo` (this lane's repo). */
export interface SubmissionLinkStore {
  insert(input: Omit<MissionLink, "createdAt" | "updatedAt">): MissionLink;
  get(childMissionId: string): MissionLink | null;
  listChildren(parentMissionId: string, kind?: MissionLinkKind | null): MissionLink[];
  listUnsettled(): MissionLink[];
  setIntegration(childMissionId: string, integration: SubMissionIntegration): MissionLink | null;
  setWorktree(childMissionId: string, worktree: string | null): MissionLink | null;
}

/** @nova/storage `CostRepo` subset. */
export interface SubmissionCostStore {
  reserve(input: { missionId: string; amountUsd: number; missionBudgetUsd: number | null; dailyLimitUsd: number | null; dayStart: number; backsSubmission?: boolean }):
    | { ok: true; reservation: { id: string } }
    | { ok: false; reason: "budget" | "daily_budget"; availableUsd: number };
  settle(reservationId: string, actualUsd: number | null): void;
  release(reservationId: string): void;
  summary(missionId: string, dayStart: number): { committedUsd: number; spentUsd: number };
}

/** @nova/workspace `WorktreeManager` subset. */
export interface SubmissionWorktrees {
  add(projectRoot: string, id: string): Promise<{ root: string; baseSha: string }>;
  get(projectRoot: string, id: string): Promise<{ root: string; baseSha: string } | null>;
  changes(info: { root: string; baseSha: string; path: string; id: string }): Promise<{
    changes: { path: RelativePath; change: "added" | "modified" | "deleted" }[];
    truncated: boolean;
  }>;
  changedInProject(projectRoot: string, baseSha: string, paths: readonly RelativePath[]): Promise<Set<RelativePath>>;
  remove(projectRoot: string | null, id: string): Promise<void>;
  list(): Promise<string[]>;
}

export interface ChildTestsOutcome {
  /**
   * `unavailable` = no test command is known for the project; `refused` = the permission engine
   * denies running it. Either way nothing is integrated.
   */
  status: "passed" | "failed" | "unavailable" | "refused";
}

export interface SubmissionIntegrationDeps {
  /** Current bytes of a project file (null = absent). Confined, C8-checked by the implementation. */
  readProject(workspaceId: string, path: RelativePath): Promise<Uint8Array | null>;
  /** Bytes of a worktree file (null = absent). Confined to `root`. */
  readWorktree(root: string, path: RelativePath): Promise<Uint8Array | null>;
  /** The permission engine (evaluated and audited in main) for each path written into the project. */
  evaluate(request: PermissionRequest): Promise<PermissionDecision>;
  createCheckpoint(input: { workspaceId: string; missionId: string; label: string }): { id: string };
  /** The project's agent file API (checkpointed, hash-checked writes). */
  files(workspaceId: string): Promise<Pick<WorkspaceFileApi, "writeFile" | "trash">>;
  /** The project's tests, run on the worktree `root` at L0 (permission evaluated by the implementation). */
  runTests(input: { workspaceId: string; missionId: string; root: string; signal: AbortSignal }): Promise<ChildTestsOutcome>;
}

export interface SubmissionsControllerDeps {
  links: SubmissionLinkStore;
  missions: {
    get(missionId: string): Mission | null;
    contractOf(missionId: string): MissionContract | null;
    plan(req: MissionPlanRequest): Promise<MissionPlanResult>;
    /** `tainted`: the child starts with its parent's W5 taint (its goal is the parent model's text). */
    start(req: MissionStartRequest & { tainted: boolean }): Promise<Mission>;
    stop(req: MissionIdRequest): Promise<Mission>;
    /** W5: untrusted content entered this mission's context (`MissionController.isTainted`). */
    isTainted(missionId: string): boolean;
  };
  cost: SubmissionCostStore;
  /** Parent journal (`MissionController.journal.append`): `submission.updated`. */
  journal: { append(event: MissionEventInput): MissionEvent | null };
  /** null = git worktrees unavailable: writing children are refused. */
  worktrees: SubmissionWorktrees | null;
  projectRoot(workspaceId: string): Promise<string>;
  integration: SubmissionIntegrationDeps;
  dailyLimitUsd(): number;
  /** A writing child's end: stop its processes (its runner is rooted in the worktree). */
  onChildEnded?(childMissionId: string): void;
  now?: () => number;
}

const INTEGRABLE: readonly SubMissionIntegration[] = ["pending", "tests_failed", "conflict"];
const MIN_BUDGET_USD = 0.001;

function startOfDay(time: number): number {
  const date = new Date(time);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sameBytes(a: Uint8Array | null, b: Uint8Array | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.byteLength !== b.byteLength) return false;
  for (let index = 0; index < a.byteLength; index += 1) if (a[index] !== b[index]) return false;
  return true;
}

/**
 * The worktree's checkout may convert line endings (`core.autocrlf` on Windows) where the project's
 * file does not have them: the integrated text keeps the line endings of the project's file, so an
 * integration never rewrites every line. Mixed or absent line endings: the child's text as is.
 */
function withLineEndingsOf(current: string | null, text: string): string {
  const lines = current?.match(/\n/g)?.length ?? 0;
  if (current === null || lines === 0) return text;
  const crlf = current.match(/\r\n/g)?.length ?? 0;
  const lf = text.replace(/\r\n/g, "\n");
  if (crlf === 0) return lf;
  return crlf === lines ? lf.replace(/\n/g, "\r\n") : text;
}

const utf8 = new TextDecoder("utf-8", { fatal: true });
function textOf(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null;
  try {
    return utf8.decode(bytes);
  } catch {
    return null;
  }
}

function usd(amount: number): string {
  return `${(Math.floor(amount * 10_000) / 10_000).toFixed(4)} USD`;
}

interface PlannedWrite {
  path: RelativePath;
  change: "added" | "modified" | "deleted";
  /** Project content now (null = absent). */
  current: Uint8Array | null;
  /** New text (null = delete). */
  next: string | null;
}

export function createSubmissionsController(deps: SubmissionsControllerDeps): SubmissionsController {
  const now = deps.now ?? Date.now;
  /** Parent reservation of each child (in memory: after a restart the journal released them). */
  const reservations = new Map<string, string>();
  /** Children whose end was already settled in this process (terminal events are delivered once, but start failures race). */
  const settled = new Set<string>();
  /** End handling in flight per child: a second caller waits for the same work. */
  const finishing = new Map<string, Promise<void>>();
  /** Worktree roots of running writing children. */
  const roots = new Map<string, string>();
  let queue: Promise<unknown> = Promise.resolve();
  let active = 0;

  const missionOf = (id: string): Mission => {
    const mission = deps.missions.get(id);
    if (!mission) throw new SubmissionError("not_found", "mission not found");
    return mission;
  };

  const submissionLink = (childMissionId: string): MissionLink => {
    const link = deps.links.get(childMissionId);
    if (!link || link.kind !== "submission") throw new SubmissionError("not_found", "sub-mission not found");
    return link;
  };

  const report = (link: MissionLink): void => {
    const child = deps.missions.get(link.childMissionId);
    if (!child) return;
    deps.journal.append({ type: "submission.updated", missionId: link.parentMissionId, link, childState: child.state });
  };

  const setIntegration = (childMissionId: string, integration: SubMissionIntegration): MissionLink => {
    const link = deps.links.setIntegration(childMissionId, integration);
    if (!link) throw new SubmissionError("not_found", "sub-mission not found");
    return link;
  };

  const removeWorktree = async (link: MissionLink): Promise<MissionLink> => {
    roots.delete(link.childMissionId);
    if (link.worktree === null) return link;
    const mission = deps.missions.get(link.childMissionId);
    const projectRoot = mission ? await deps.projectRoot(mission.workspaceId).catch(() => null) : null;
    await deps.worktrees?.remove(projectRoot, link.worktree).catch(() => undefined);
    return deps.links.setWorktree(link.childMissionId, null) ?? link;
  };

  /**
   * The parent pays what the child really cost, once: its reservation (if still open) is released
   * and the real cost is committed on the parent. Unknown costs keep their estimate (committed), so
   * the larger of committed and reported is taken.
   */
  const settleBudget = (link: MissionLink): void => {
    const reservationId = reservations.get(link.childMissionId);
    if (reservationId !== undefined) deps.cost.release(reservationId);
    reservations.delete(link.childMissionId);
    const summary = deps.cost.summary(link.childMissionId, startOfDay(now()));
    const actual = Math.max(summary.committedUsd, summary.spentUsd);
    if (actual <= 0) return;
    const charge = deps.cost.reserve({ missionId: link.parentMissionId, amountUsd: actual, missionBudgetUsd: null, dailyLimitUsd: null, dayStart: startOfDay(now()) });
    if (charge.ok) deps.cost.settle(charge.reservation.id, actual);
  };

  /** A child ended: settle the parent's budget, decide what is left to integrate, tell the parent. */
  const finishChild = (childMissionId: string, state: MissionState): Promise<void> => {
    const known = finishing.get(childMissionId);
    if (known) return known;
    if (settled.has(childMissionId)) return Promise.resolve();
    const work = finishNow(childMissionId, state);
    finishing.set(childMissionId, work);
    void work.finally(() => finishing.delete(childMissionId)).catch(() => undefined);
    return work;
  };

  const finishNow = async (childMissionId: string, state: MissionState): Promise<void> => {
    settled.add(childMissionId);
    const link = deps.links.get(childMissionId);
    if (!link || link.kind !== "submission") return;
    active = Math.max(0, active - 1);
    deps.onChildEnded?.(childMissionId);
    settleBudget(link);
    let next: MissionLink = link;
    if (link.worktree === null) {
      next = setIntegration(childMissionId, link.integration ?? "not_needed");
    } else if (state !== "succeeded") {
      next = await removeWorktree(setIntegration(childMissionId, "discarded"));
    } else {
      // Reading the worktree can fail (git timeout, project unmounted): the child has ended all the
      // same, so it is offered for integration (which reads it again) or discard, never left « en cours ».
      next = await pendingOrEmpty(link).catch(() => setIntegration(childMissionId, "pending"));
    }
    report(next);
  };

  /** A succeeded writing child: `pending` when its worktree holds changes, else nothing to integrate. */
  const pendingOrEmpty = async (link: MissionLink): Promise<MissionLink> => {
    const mission = missionOf(link.childMissionId);
    const projectRoot = await deps.projectRoot(mission.workspaceId);
    const info = link.worktree && deps.worktrees ? await deps.worktrees.get(projectRoot, link.worktree) : null;
    if (!info || !link.worktree || !deps.worktrees) return removeWorktree(setIntegration(link.childMissionId, "discarded"));
    const { changes } = await deps.worktrees.changes({ ...info, path: info.root, id: link.worktree });
    if (changes.length === 0) return removeWorktree(setIntegration(link.childMissionId, "not_needed"));
    return setIntegration(link.childMissionId, "pending");
  };

  const treeOf = (missionId: string): MissionTreeNode => {
    const mission = missionOf(missionId);
    const link = deps.links.get(missionId);
    if (link?.kind === "submission") return { mission, link, children: [] };
    const children = deps.links
      .listChildren(missionId, "submission")
      .flatMap((child) => {
        const childMission = deps.missions.get(child.childMissionId);
        return childMission ? [{ mission: childMission, link: child }] : [];
      });
    return { mission, link, children };
  };

  const runningChildren = (parentMissionId: string): number =>
    deps.links
      .listChildren(parentMissionId, "submission")
      .filter((link) => {
        const child = deps.missions.get(link.childMissionId);
        return child !== null && !isTerminalMissionState(child.state);
      }).length;

  // -------------------------------------------------------------------------
  // start

  async function start(request: SubMissionStart, signal: AbortSignal): Promise<{ link: MissionLink; title: string }> {
    const parent = missionOf(request.parentMissionId);
    if (parent.workspaceId !== request.workspaceId) throw new SubmissionError("invalid_request", "workspace mismatch");
    if (isTerminalMissionState(parent.state)) throw new SubmissionError("conflict", "this mission has ended");
    const contract = deps.missions.contractOf(parent.id);
    if (!contract) throw new SubmissionError("not_found", "mission contract not found");
    const options = missionHarnessOf(contract).subMissions;
    if (!options) throw new SubmissionError("invalid_request", "sub-missions are not enabled in this mission's contract");
    const ownLink = deps.links.get(parent.id);
    if (ownLink?.kind === "submission") {
      throw new SubmissionError("invalid_request", "a sub-mission cannot start sub-missions (depth is limited to 1)");
    }
    const maxChildren = Math.min(options.maxChildren, SUBMISSION_LIMITS.maxChildren);
    if (deps.links.listChildren(parent.id, "submission").length >= maxChildren) {
      throw new SubmissionError("conflict", `this mission already started its ${maxChildren} allowed sub-mission${maxChildren === 1 ? "" : "s"}; do the rest yourself`);
    }
    if (runningChildren(parent.id) >= SUBMISSION_LIMITS.maxParallel) {
      throw new SubmissionError("conflict", `${SUBMISSION_LIMITS.maxParallel} sub-missions are already running; continue yourself and delegate later if still needed`);
    }
    const title = request.title.trim();
    const goal = request.goal.trim();
    if (title === "" || goal === "") throw new SubmissionError("invalid_request", "title and goal are required");
    if (goal.length > SUBMISSION_LIMITS.goalMaxChars) throw new SubmissionError("invalid_request", `goal is longer than ${SUBMISSION_LIMITS.goalMaxChars} characters`);
    if (!Number.isFinite(request.budgetUsd) || request.budgetUsd < MIN_BUDGET_USD) {
      throw new SubmissionError("invalid_request", `budgetUsd must be at least ${MIN_BUDGET_USD}`);
    }
    if (parent.modelId === null) throw new SubmissionError("invalid_request", "this mission has no model");
    const derived = childContractInput(contract, request.mode, request.budgetUsd);
    if (!derived.ok) throw new SubmissionError("invalid_request", derived.reason);
    if (derived.writes && !deps.worktrees) {
      throw new SubmissionError("unavailable", "a writing sub-mission needs git worktrees, unavailable here; delegate a read-only one (understand, plan or verify) or do it yourself");
    }
    if (signal.aborted) throw new SubmissionError("conflict", "cancelled");

    // Shared budget: held on the parent BEFORE the child spends anything. It must fit what is left
    // today, but once held it is left out of the day's total: the child's own calls reserve and
    // record their usage against the daily cap themselves (counting both would count twice).
    const reserved = deps.cost.reserve({
      missionId: parent.id,
      amountUsd: request.budgetUsd,
      missionBudgetUsd: contract.budgetUsd,
      dailyLimitUsd: deps.dailyLimitUsd(),
      dayStart: startOfDay(now()),
      backsSubmission: true,
    });
    if (!reserved.ok) {
      const scope = reserved.reason === "budget" ? "this mission's budget" : "today's budget";
      throw new SubmissionError("conflict", `not enough budget left for this sub-mission: ${usd(reserved.availableUsd)} available in ${scope}; ask for less or do it yourself`);
    }
    const reservationId = reserved.reservation.id;
    const projectRoot = derived.writes ? await deps.projectRoot(parent.workspaceId) : null;

    let childId: string | null = null;
    let worktree: string | null = null;
    try {
      const plan = await deps.missions.plan({
        workspaceId: parent.workspaceId,
        conversationId: null,
        // The mission title is the goal's first line.
        goal: `${title}\n\n${goal}`,
        mode: request.mode,
        modelId: parent.modelId,
        contract: derived.input,
      });
      childId = plan.mission.id;
      reservations.set(childId, reservationId);
      if (derived.writes && projectRoot !== null && deps.worktrees) {
        const info = await deps.worktrees.add(projectRoot, childId);
        worktree = childId;
        roots.set(childId, info.root);
      }
      const link = deps.links.insert({
        childMissionId: childId,
        parentMissionId: parent.id,
        kind: "submission",
        forkSeq: null,
        depth: 1,
        reservedUsd: request.budgetUsd,
        worktree,
        integration: derived.writes ? null : "not_needed",
      });
      active += 1;
      if (signal.aborted) throw new SubmissionError("conflict", "cancelled");
      // The goal is free text from the parent's model: after untrusted content it may carry an
      // injected instruction, so the child inherits the taint (no W5 laundering through delegation).
      await deps.missions.start({ missionId: childId, tasks: null, contract: derived.input, tainted: deps.missions.isTainted(parent.id) });
      return { link: deps.links.get(childId) ?? link, title: plan.mission.title };
    } catch (error) {
      await abandonStart(childId, reservationId, projectRoot, worktree);
      if (error instanceof SubmissionError) throw error;
      const code = typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : null;
      if (code === "conflict") throw new SubmissionError("conflict", "not enough budget to plan the sub-mission");
      throw new SubmissionError(childId === null ? "provider" : "unavailable", childId === null ? "the sub-mission could not be planned" : "the sub-mission could not start");
    }
  }

  /** Undoes a start that did not go through: no reservation, no worktree, no child left `ready`. */
  async function abandonStart(childId: string | null, reservationId: string, projectRoot: string | null, worktree: string | null): Promise<void> {
    if (childId === null) {
      deps.cost.release(reservationId);
      return;
    }
    const child = deps.missions.get(childId);
    if (child && !isTerminalMissionState(child.state)) await deps.missions.stop({ missionId: childId }).catch(() => undefined);
    roots.delete(childId);
    if (worktree !== null) await deps.worktrees?.remove(projectRoot, worktree).catch(() => undefined);
    const link = deps.links.get(childId);
    if (link) {
      deps.links.setWorktree(childId, null);
      if (link.integration === null) deps.links.setIntegration(childId, "discarded");
    }
    // The plan already cost something: the parent pays it like any child's cost.
    if (link && !settled.has(childId)) {
      settled.add(childId);
      active = Math.max(0, active - 1);
      settleBudget(link);
    } else if (!link) {
      deps.cost.release(reservationId);
      reservations.delete(childId);
    }
  }

  // -------------------------------------------------------------------------
  // integration

  async function integrateNow(childMissionId: string): Promise<MissionTreeNode> {
    const link = submissionLink(childMissionId);
    const child = missionOf(childMissionId);
    if (link.integration === "integrated") return treeOf(link.parentMissionId);
    if (link.worktree === null || link.integration === null || !INTEGRABLE.includes(link.integration)) {
      throw new SubmissionError("conflict", link.integration === null ? "the sub-mission is still running" : "nothing to integrate");
    }
    if (child.state !== "succeeded") throw new SubmissionError("conflict", "only a succeeded sub-mission can be integrated");
    if (!deps.worktrees) throw new SubmissionError("unavailable", "git worktrees are unavailable");
    const worktrees = deps.worktrees;
    const projectRoot = await deps.projectRoot(child.workspaceId);
    const info = await worktrees.get(projectRoot, link.worktree);
    if (!info) {
      report(await removeWorktree(setIntegration(childMissionId, "discarded")));
      throw new SubmissionError("not_found", "the sub-mission's worktree is gone: it was discarded");
    }

    report(setIntegration(childMissionId, "testing"));
    const back = (state: SubMissionIntegration): MissionTreeNode => {
      report(setIntegration(childMissionId, state));
      return treeOf(link.parentMissionId);
    };
    try {
      // What will be written is fixed BEFORE the tests run: files the tests themselves create or
      // touch in the worktree are never integrated, and the project gets exactly what was tested.
      const { changes, truncated } = await worktrees.changes({ ...info, path: info.root, id: link.worktree });
      if (truncated) return back("conflict");
      if (changes.length === 0) {
        report(await removeWorktree(setIntegration(childMissionId, "not_needed")));
        return treeOf(link.parentMissionId);
      }
      const plan = await planWrites(worktrees, child, projectRoot, info, changes);
      if (plan === "conflict") return back("conflict");
      if (plan === "denied") {
        back("pending");
        throw new SubmissionError("conflict", "the permission rules refuse a file of this sub-mission: it cannot be integrated");
      }

      const tests = await deps.integration.runTests({ workspaceId: child.workspaceId, missionId: childMissionId, root: info.root, signal: new AbortController().signal });
      if (tests.status === "unavailable") {
        back("pending");
        throw new SubmissionError("unavailable", "no test command is known for this project: nothing is integrated without green tests");
      }
      if (tests.status === "refused") {
        back("pending");
        throw new SubmissionError("conflict", "the permission rules refuse running the project's tests: nothing is integrated without green tests");
      }
      if (tests.status === "failed") return back("tests_failed");

      // The user may have edited the project while the tests ran: each write re-checks its hash.
      const applied = await applyWrites(child, plan);
      if (!applied) return back("conflict");
      report(await removeWorktree(setIntegration(childMissionId, "integrated")));
      return treeOf(link.parentMissionId);
    } catch (error) {
      if (deps.links.get(childMissionId)?.integration === "testing") back("pending");
      if (error instanceof SubmissionError) throw error;
      throw new SubmissionError("unavailable", "the integration could not run");
    }
  }

  /**
   * What would be written, checked BEFORE anything is: every path the user changed since the child
   * started is a conflict (never overwritten), binary content is not integrated, and each write or
   * delete is evaluated by the permission engine (a `deny` refuses the whole integration; an `ask`
   * is answered by the user's click on « Intégrer »).
   */
  async function planWrites(
    worktrees: SubmissionWorktrees,
    child: Mission,
    projectRoot: string,
    info: { root: string; baseSha: string },
    changes: { path: RelativePath; change: "added" | "modified" | "deleted" }[],
  ): Promise<PlannedWrite[] | "conflict" | "denied"> {
    const touchedSinceBase = await worktrees.changedInProject(
      projectRoot,
      info.baseSha,
      changes.filter((item) => item.change !== "added").map((item) => item.path),
    );
    const writes: PlannedWrite[] = [];
    for (const item of changes) {
      const current = await deps.integration.readProject(child.workspaceId, item.path);
      const incoming = item.change === "deleted" ? null : await deps.integration.readWorktree(info.root, item.path);
      if (item.change !== "deleted" && incoming === null) return "conflict";
      if (sameBytes(current, incoming)) continue; // already there
      if (item.change === "added" ? current !== null : touchedSinceBase.has(item.path)) return "conflict";
      const text = incoming === null ? null : textOf(incoming);
      if (incoming !== null && text === null) return "conflict";
      const currentText = current === null ? null : textOf(current);
      const next = text === null ? null : withLineEndingsOf(currentText, text);
      if (next !== null && next === currentText) continue; // only the checkout's line endings differ
      writes.push({ path: item.path, change: item.change, current, next });
    }
    for (const write of writes) {
      const deleting = write.next === null;
      const decision = await deps.integration.evaluate({
        workspaceId: child.workspaceId,
        missionId: child.id,
        tool: deleting ? "delete_path" : "write_file",
        operation: deleting ? "delete" : "write",
        path: write.path,
        mode: child.mode,
      });
      if (decision.decision === "deny") return "denied";
    }
    return writes;
  }

  /** Writes under one restore point; on a failure midway, what was written is put back. */
  async function applyWrites(child: Mission, writes: PlannedWrite[]): Promise<boolean> {
    if (writes.length === 0) return true;
    const checkpoint = deps.integration.createCheckpoint({ workspaceId: child.workspaceId, missionId: child.id, label: `Intégration : ${child.title}` });
    const files = await deps.integration.files(child.workspaceId);
    const done: { write: PlannedWrite; hash: string | null }[] = [];
    try {
      for (const write of writes) {
        const expectedHash = write.current === null ? null : sha256(write.current);
        if (write.next === null) {
          if (write.current !== null) await files.trash(write.path, { checkpointId: checkpoint.id });
          done.push({ write, hash: null });
          continue;
        }
        const outcome = await files.writeFile(write.path, write.next, { expectedHash, checkpointId: checkpoint.id });
        if (outcome.status !== "written") throw new Error("conflict");
        done.push({ write, hash: outcome.hash });
      }
      return true;
    } catch {
      for (const { write, hash } of done.reverse()) {
        try {
          const original = write.current === null ? null : textOf(write.current);
          if (write.current === null && hash !== null) await files.trash(write.path, { checkpointId: checkpoint.id });
          else if (original !== null) await files.writeFile(write.path, original, { expectedHash: hash, checkpointId: checkpoint.id });
        } catch {
          // The restore point holds the previous content: the user can restore it from there.
        }
      }
      return false;
    }
  }

  const enqueue = <T>(job: () => Promise<T>): Promise<T> => {
    const run = queue.then(job, job);
    queue = run.catch(() => undefined);
    return run;
  };

  const controller: SubmissionsController = {
    start,

    async tree(missionId) {
      return treeOf(missionId);
    },

    integrate(childMissionId) {
      submissionLink(childMissionId);
      return enqueue(() => integrateNow(childMissionId));
    },

    async discard(childMissionId) {
      const link = submissionLink(childMissionId);
      if (link.integration === "integrated") throw new SubmissionError("conflict", "already integrated: use the restore point to undo it");
      if (link.integration === "testing") throw new SubmissionError("conflict", "integration in progress");
      if (link.integration === "discarded") return treeOf(link.parentMissionId);
      const child = missionOf(childMissionId);
      if (!isTerminalMissionState(child.state)) {
        await deps.missions.stop({ missionId: childMissionId });
        await finishChild(childMissionId, "cancelled");
      }
      return enqueue(async () => {
        const current = submissionLink(childMissionId);
        if (current.integration === "integrated" || current.integration === "discarded") return treeOf(current.parentMissionId);
        report(await removeWorktree(setIntegration(childMissionId, "discarded")));
        return treeOf(current.parentMissionId);
      });
    },

    onMissionEvent(event) {
      if (event.type !== "mission.succeeded" && event.type !== "mission.failed" && event.type !== "mission.cancelled") return;
      const state: MissionState = event.type === "mission.succeeded" ? "succeeded" : event.type === "mission.failed" ? "failed" : "cancelled";
      const link = deps.links.get(event.missionId);
      if (link?.kind === "submission") void finishChild(event.missionId, state).catch(() => undefined);
      // Stopping a mission stops its tree: children still running are stopped too.
      if (event.type === "mission.cancelled") {
        for (const child of deps.links.listChildren(event.missionId, "submission")) {
          const mission = deps.missions.get(child.childMissionId);
          if (mission && !isTerminalMissionState(mission.state)) void deps.missions.stop({ missionId: child.childMissionId }).catch(() => undefined);
        }
      }
    },

    async workspaceRootOf(missionId) {
      const known = roots.get(missionId);
      if (known) return known;
      const link = deps.links.get(missionId);
      if (link?.kind !== "submission" || link.worktree === null || !deps.worktrees) return null;
      const mission = deps.missions.get(missionId);
      if (!mission) return null;
      const info = await deps.worktrees.get(await deps.projectRoot(mission.workspaceId), link.worktree).catch(() => null);
      if (info) roots.set(missionId, info.root);
      return info?.root ?? null;
    },

    async recover() {
      for (const link of deps.links.listUnsettled()) {
        const child = deps.missions.get(link.childMissionId);
        if (!child) continue;
        if (link.integration === "testing") {
          report(setIntegration(link.childMissionId, "pending"));
          continue;
        }
        if (link.integration !== null) continue;
        // A child left `ready` by a crash between its plan and its start never runs: it is closed.
        if (child.state === "ready") await deps.missions.stop({ missionId: child.id }).catch(() => undefined);
        const state = deps.missions.get(child.id)?.state ?? child.state;
        if (isTerminalMissionState(state)) await finishChild(link.childMissionId, state).catch(() => undefined);
      }
      if (!deps.worktrees) return;
      for (const id of await deps.worktrees.list()) {
        const link = deps.links.get(id);
        const keep = link?.kind === "submission" && link.worktree === id && (link.integration === null || INTEGRABLE.includes(link.integration));
        if (keep) continue;
        const mission = deps.missions.get(id);
        const projectRoot = mission ? await deps.projectRoot(mission.workspaceId).catch(() => null) : null;
        await deps.worktrees.remove(projectRoot, id).catch(() => undefined);
        if (link?.worktree === id) deps.links.setWorktree(id, null);
      }
    },

    get activeCount() {
      return active;
    },
  };
  return controller;
}

/** Modes a sub-mission may be started in (every mode but Discuter). */
export const SUBMISSION_MODES: readonly Exclude<WorkMode, "discuss">[] = ["understand", "plan", "build", "fix", "verify"];
