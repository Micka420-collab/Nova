// `submissions.*` IPC group and `ToolDeps.submissions` (J2-B L5): wires the sub-missions controller
// (@nova/missions) to the SQLite repos (mission_links, cost), the mission controller (children are
// ordinary missions: plan + start), the git worktrees of writing children, the permission engine,
// the project's checkpointed file API and an L0 command runner for the tests run before an
// integration. No Electron import: tested in Node.
//
// Tool routing: a writing child works in its worktree. `toolDepsFor(workspaceId, missionId, base)`
// gives the mission controller's `tools()` the deps of THAT mission: for such a child, files and
// commands are rooted in the worktree (git and process tools are not offered there, and it never
// delegates); every other mission gets `base` plus the sub-mission starter.
import {
  SubmissionError,
  createSubmissionsController,
  type ChildTestsOutcome,
  type MissionController,
  type SubmissionWorktrees,
  type SubmissionsController,
} from "@nova/missions";
import {
  TOOL_LIMITS,
  type Checkpoint,
  type CheckpointReason,
  type PermissionDecision,
  type PermissionRequest,
  type RelativePath,
  type WorkspaceFacts,
} from "@nova/shared";
import { createMissionLinkRepo, createMissionRepo, type NovaStore } from "@nova/storage";
import type { CommandRunner, ToolDeps, WorkspaceFileApi } from "@nova/tools";
import { readBytesOrNull } from "@nova/workspace";
import type { MainApi } from "../api";
import { ServiceError } from "../service-error";

/** Longest run of the project's tests before an integration. */
export const INTEGRATION_TESTS_TIMEOUT_MS = 10 * 60_000;
/** Largest file compared or integrated (bigger ones make the integration a conflict). */
const INTEGRATION_FILE_MAX_BYTES = 5 * 1024 * 1024;

export interface SubmissionsServiceDeps {
  store: NovaStore;
  /** The mission controller: children are planned, started and stopped like any mission. */
  missions: Pick<MissionController, "plan" | "start" | "stop" | "contractOf" | "journal" | "isTainted">;
  /** `createWorktreeManager({ dataDir })` (@nova/workspace); null = git unavailable (read-only children only). */
  worktrees: SubmissionWorktrees | null;
  /** Canonical project root (`workspaceService.rootOf`). */
  rootOf(workspaceId: string): Promise<string>;
  facts(workspaceId: string): Promise<WorkspaceFacts | null>;
  /** L1 `PermissionsService.evaluateOnDisk` (records the decision in the audit). */
  permissions: { evaluate(request: PermissionRequest): PermissionDecision | Promise<PermissionDecision> };
  /** L2 checkpoints `store.create`. */
  checkpoints: { create(input: { workspaceId: string; missionId: string | null; label: string; reason: CheckpointReason }): Checkpoint };
  /** The project's agent file API (`filesService.fileOpsFor`). */
  projectFiles(workspaceId: string): Promise<Pick<WorkspaceFileApi, "writeFile" | "trash">>;
  /** Agent file API rooted in a worktree (`createWorkspaceFileOps({ root, … })`, same checkpoint store). */
  worktreeFiles(workspaceId: string, root: string): WorkspaceFileApi | Promise<WorkspaceFileApi>;
  /** L0 command runner whose cwd resolves inside `root` (`createProcessCommandRunner`). */
  commandRunner(root: string): CommandRunner;
  dailyLimitUsd(): number;
  now?: () => number;
}

export interface SubmissionsService {
  api: MainApi["submissions"];
  controller: SubmissionsController;
  /** Tool deps of one mission (see the header): wire the mission controller's `tools()` through it. */
  toolDepsFor(workspaceId: string, missionId: string, base: ToolDeps): Promise<ToolDeps>;
  /** Processes of a writing child run in its own runner: stop them there too (mission stop, exit). */
  stopAll(missionId: string): Promise<void>;
  stopEverything(): Promise<void>;
}

function toServiceError(error: unknown): unknown {
  if (error instanceof SubmissionError) return new ServiceError(error.code, error.message);
  return error;
}

export function createSubmissionsService(deps: SubmissionsServiceDeps): SubmissionsService {
  const missions = createMissionRepo(deps.store.db);
  const links = createMissionLinkRepo(deps.store.db);
  const cost = missions.cost;
  /** One runner per writing child, rooted in its worktree. */
  const runners = new Map<string, { root: string; runner: CommandRunner }>();

  const runnerFor = (missionId: string, root: string): CommandRunner => {
    const known = runners.get(missionId);
    if (known?.root === root) return known.runner;
    const runner = deps.commandRunner(root);
    runners.set(missionId, { root, runner });
    return runner;
  };

  const stopAll = async (missionId: string): Promise<void> => {
    const known = runners.get(missionId);
    runners.delete(missionId);
    await known?.runner.stopAll(missionId).catch(() => undefined);
  };

  /**
   * The project's tests on the worktree, at L0, after the permission engine allowed the command for
   * this child (an `ask` is answered by the user's « Intégrer »; a `deny` refuses). Only the exit
   * code decides.
   */
  const runTests = async (input: { workspaceId: string; missionId: string; root: string; signal: AbortSignal }): Promise<ChildTestsOutcome> => {
    const facts = await deps.facts(input.workspaceId).catch(() => null);
    const argv = facts?.testRunner?.command ?? [];
    if (argv.length === 0) return { status: "unavailable" };
    const mission = missions.get(input.missionId);
    const decision = await deps.permissions.evaluate({
      workspaceId: input.workspaceId,
      missionId: input.missionId,
      tool: "run_tests",
      operation: "execute",
      argv,
      ...(mission ? { mode: mission.mode } : {}),
    });
    if (decision.decision === "deny") return { status: "refused" };
    const runner = deps.commandRunner(input.root);
    try {
      const outcome = await runner.run(
        { workspaceId: input.workspaceId, missionId: input.missionId, argv, cwd: "", timeoutMs: Math.max(TOOL_LIMITS.commandTimeoutMs, INTEGRATION_TESTS_TIMEOUT_MS), env: { CI: "1" } },
        input.signal,
      );
      return { status: outcome.exitCode === 0 && !outcome.timedOut && !outcome.cancelled ? "passed" : "failed" };
    } finally {
      await runner.stopAll(input.missionId).catch(() => undefined);
    }
  };

  const readBytes = async (root: string, path: RelativePath): Promise<Uint8Array | null> =>
    readBytesOrNull(root, path, INTEGRATION_FILE_MAX_BYTES);

  const controller = createSubmissionsController({
    links,
    missions: {
      get(id) {
        const record = missions.get(id);
        if (!record) return null;
        const { contract: _contract, ...mission } = record;
        return mission;
      },
      contractOf: (id) => deps.missions.contractOf(id),
      plan: (req) => deps.missions.plan(req),
      start: (req) => deps.missions.start(req),
      stop: (req) => deps.missions.stop(req),
      isTainted: (id) => deps.missions.isTainted(id),
    },
    cost,
    journal: { append: (event) => deps.missions.journal.append(event) },
    worktrees: deps.worktrees,
    projectRoot: (workspaceId) => deps.rootOf(workspaceId),
    integration: {
      readProject: async (workspaceId, path) => readBytes(await deps.rootOf(workspaceId), path),
      readWorktree: (root, path) => readBytes(root, path),
      evaluate: async (request) => deps.permissions.evaluate(request),
      createCheckpoint: (input) => deps.checkpoints.create({ ...input, reason: "tool_write" }),
      files: (workspaceId) => deps.projectFiles(workspaceId),
      runTests,
    },
    dailyLimitUsd: deps.dailyLimitUsd,
    onChildEnded: (missionId) => void stopAll(missionId),
    ...(deps.now ? { now: deps.now } : {}),
  });

  const guard =
    <A, R>(fn: (arg: A) => Promise<R>) =>
    async (arg: A): Promise<R> => {
      try {
        return await fn(arg);
      } catch (error) {
        throw toServiceError(error);
      }
    };

  return {
    controller,
    api: {
      tree: guard(({ missionId }) => controller.tree(missionId)),
      integrate: guard(({ childMissionId }) => controller.integrate(childMissionId)),
      discard: guard(({ childMissionId }) => controller.discard(childMissionId)),
    },
    async toolDepsFor(workspaceId, missionId, base) {
      const root = await controller.workspaceRootOf(missionId);
      if (root === null) return { ...base, submissions: controller };
      return {
        ...base,
        files: await deps.worktreeFiles(workspaceId, root),
        commands: runnerFor(missionId, root),
        // Git reads and process tools would describe the project, not this child's copy.
        git: null,
        processes: null,
        submissions: null,
      };
    },
    stopAll,
    async stopEverything() {
      await Promise.all([...runners.keys()].map((missionId) => stopAll(missionId)));
    },
  };
}
