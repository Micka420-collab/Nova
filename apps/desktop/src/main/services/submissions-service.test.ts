// SubmissionsService end to end without Electron: a REAL git repository, REAL worktrees under a
// temp data dir, the REAL checkpointed file API and L0 command runner, SQLite repos in memory. The
// mission controller is a stand-in (children are rows moved through their states by the test).
// Checked: a writing child's tools are rooted in its worktree, nothing reaches the project before
// the integration, the integration runs the project's tests on the worktree then writes under a
// restore point, failing or refused tests integrate nothing, and no worktree is left behind.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MissionContract, MissionEvent, MissionState, PermissionRequest, WorkspaceFacts } from "@nova/shared";
import { createMissionRepo, createWorkspaceRepo, openNovaStore, type MissionRepo, type NovaStore } from "@nova/storage";
import { createProcessCommandRunner, type ToolDeps } from "@nova/tools";
import {
  createCheckpointStore,
  createIgnoreMatcher,
  createObjectStore,
  createWorkspaceFileOps,
  resolveExisting,
  sha256,
  type CheckpointStore,
} from "@nova/workspace";
import { memoryFiles } from "../../../../../packages/tools/src/__fixtures__/memory-files";
import { createMemoryCheckpointIndex, makeTempDir, type TempDir } from "../../../../../packages/workspace/src/test-support";
import { createWorktreeManager } from "../../../../../packages/workspace/src/worktree";
import { ServiceError } from "../service-error";
import { createSubmissionsService, type SubmissionsService } from "./submissions-service";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "t@example.test",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "t@example.test",
  GIT_CONFIG_NOSYSTEM: "1",
};
const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" });

/** The project's "tests": pass while ok.txt says yes. */
const TEST_COMMAND = [process.execPath, "-e", "process.exit(require('fs').readFileSync('ok.txt','utf8').trim()==='yes'?0:1)"];

let project: TempDir;
let data: TempDir;
let store: NovaStore;
let missions: MissionRepo;
let checkpoints: CheckpointStore;
let service: SubmissionsService;
let workspaceId: string;
let parentId: string;
let evaluated: PermissionRequest[];
let denyTests: boolean;
let journal: MissionEvent[];
let facts: WorkspaceFacts;

const PARENT_CONTRACT = (): MissionContract => ({
  workspaceId,
  mode: "build",
  profile: "assisted",
  isolationLevel: "L0",
  allowedOperations: ["read", "write", "delete", "execute"],
  allowedHosts: [],
  webSearch: false,
  maxDurationMs: 600_000,
  budgetUsd: 1,
  harness: { chain: false, autoContinue: null, subMissions: { maxChildren: 2 } },
});

function fileOps(root: string) {
  return createWorkspaceFileOps({ workspaceId, root, matcher: createIgnoreMatcher(root), checkpoints, rgPath: null, trash: (path) => rm(path, { recursive: true, force: true }) });
}

function end(missionId: string, state: Extract<MissionState, "succeeded" | "failed" | "cancelled">): void {
  missions.setState(missionId, state);
  const base = { id: `e-${missionId}-${state}`, missionId, seq: 99, at: Date.now() };
  const event: MissionEvent =
    state === "succeeded"
      ? { ...base, type: "mission.succeeded", summary: "ok" }
      : state === "failed"
        ? { ...base, type: "mission.failed", reason: "internal", detail: null }
        : { ...base, type: "mission.cancelled", by: "user" };
  service.controller.onMissionEvent(event);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function settle(): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
}

beforeEach(async () => {
  project = await makeTempDir("nova-sub-project-");
  data = await makeTempDir("nova-sub-data-");
  git(project.path, "init", "-q", "-b", "main");
  await project.write("src/a.txt", "alpha\n");
  await project.write("ok.txt", "yes\n");
  git(project.path, "add", "-A");
  git(project.path, "commit", "-q", "-m", "init");

  store = openNovaStore(":memory:");
  workspaceId = createWorkspaceRepo(store.db).upsertByRootPath({ rootPath: project.path, name: "p" }).id;
  missions = createMissionRepo(store.db);
  parentId = missions.create({
    workspaceId,
    conversationId: null,
    title: "Parent",
    goal: "g",
    mode: "build",
    modelId: "acme/model",
    contract: { profile: "assisted", isolationLevel: "L0", allowedOperations: ["read", "write", "delete", "execute"], allowedHosts: [], maxDurationMs: 600_000, budgetUsd: 1 },
  }).id;
  missions.setState(parentId, "running");
  checkpoints = createCheckpointStore({ index: createMemoryCheckpointIndex(), objects: createObjectStore(join(data.path, "objects")) });
  evaluated = [];
  denyTests = false;
  journal = [];
  facts = {
    workspaceId,
    detectedAt: 0,
    packageManager: null,
    languages: [],
    frameworks: [],
    testRunner: { name: "other", command: TEST_COMMAND },
    devCommand: null,
    buildCommand: null,
    git: true,
    instructionFiles: [],
  };
  const contracts = new Map<string, MissionContract>([[parentId, PARENT_CONTRACT()]]);
  let seq = 0;

  service = createSubmissionsService({
    store,
    missions: {
      async plan(req) {
        const created = missions.create({
          workspaceId: req.workspaceId,
          conversationId: null,
          title: req.goal.split("\n")[0] ?? "",
          goal: req.goal,
          mode: req.mode,
          modelId: req.modelId,
          contract: { profile: "assisted", isolationLevel: "L0", allowedOperations: req.contract?.allowedOperations ?? [], allowedHosts: [], maxDurationMs: 600_000, budgetUsd: req.contract?.budgetUsd ?? 0 },
        });
        contracts.set(created.id, { ...PARENT_CONTRACT(), mode: req.mode, harness: { chain: false, autoContinue: null, subMissions: null } });
        const { contract: _contract, ...mission } = created;
        return { mission, contract: contracts.get(created.id) as MissionContract, tasks: [], summary: "", estimate: { minUsd: null, maxUsd: null, assumptions: "" } };
      },
      async start(req) {
        missions.setState(req.missionId, "running");
        const { contract: _contract, ...mission } = missions.get(req.missionId) as NonNullable<ReturnType<MissionRepo["get"]>>;
        return mission;
      },
      async stop(req) {
        end(req.missionId, "cancelled");
        const { contract: _contract, ...mission } = missions.get(req.missionId) as NonNullable<ReturnType<MissionRepo["get"]>>;
        return mission;
      },
      contractOf: (id) => contracts.get(id) ?? null,
      isTainted: () => false,
      journal: {
        append(event) {
          const stored = { ...event, id: `j${(seq += 1)}`, seq, at: Date.now() } as MissionEvent;
          journal.push(stored);
          return stored;
        },
        isTerminated: () => false,
      },
    },
    worktrees: createWorktreeManager({ dataDir: data.path, env: GIT_ENV }),
    rootOf: async () => project.path,
    facts: async () => facts,
    permissions: {
      evaluate(request) {
        evaluated.push(request);
        const deny = denyTests && request.operation === "execute";
        return { decision: deny ? "deny" : "allow", reason: deny ? "profile_forbids" : "profile_allows", ruleId: null, rememberable: false, explanation: "" };
      },
    },
    checkpoints,
    projectFiles: async () => fileOps(project.path),
    worktreeFiles: (_workspaceId, root) => fileOps(root),
    commandRunner: (root) => createProcessCommandRunner({ resolveCwd: async (_ws, cwd) => resolveExisting(root, cwd).catch(() => null) }),
    dailyLimitUsd: () => 5,
  });
});

afterEach(async () => {
  await service.stopEverything();
  store.close();
  await project.cleanup();
  await data.cleanup();
});

const base = (): ToolDeps => ({ files: memoryFiles().api, facts: async () => null, commands: null, git: null, web: null, mcp: null });

async function startWriter(title = "Écrire le module"): Promise<{ childId: string; root: string }> {
  const { link } = await service.controller.start(
    { parentMissionId: parentId, workspaceId, title, goal: "Change src/a.txt", mode: "build", budgetUsd: 0.1 },
    new AbortController().signal,
  );
  const root = await service.controller.workspaceRootOf(link.childMissionId);
  if (!root) throw new Error("no worktree");
  return { childId: link.childMissionId, root };
}

async function childWrites(childId: string, path: string, content: string): Promise<void> {
  const deps = await service.toolDepsFor(workspaceId, childId, base());
  const current = readFileSync(join((await service.controller.workspaceRootOf(childId)) as string, path));
  const checkpoint = checkpoints.create({ workspaceId, missionId: childId, label: "step", reason: "tool_write" });
  const outcome = await deps.files.writeFile(path, content, { expectedHash: sha256(current), checkpointId: checkpoint.id });
  expect(outcome.status).toBe("written");
}

describe("submissions service", () => {
  it("roots a writing child's tools in its worktree; other missions keep the project and may delegate", async () => {
    const { childId, root } = await startWriter();
    expect(root.startsWith(join(data.path, "worktrees"))).toBe(true);
    const childDeps = await service.toolDepsFor(workspaceId, childId, base());
    expect(childDeps.submissions).toBeNull();
    expect(childDeps.git).toBeNull();
    const ran = await childDeps.commands?.run(
      { workspaceId, missionId: childId, argv: [process.execPath, "-e", "process.stdout.write(process.cwd())"], cwd: "", timeoutMs: 10_000 },
      new AbortController().signal,
    );
    expect(ran?.output).toBe(root);
    const parentDeps = await service.toolDepsFor(workspaceId, parentId, base());
    expect(parentDeps.submissions).toBe(service.controller);
  });

  it("integrates a writing child only after its tests pass on the worktree, under one restore point", async () => {
    const { childId, root } = await startWriter();
    await childWrites(childId, "src/a.txt", "alpha from the child\n");
    // Nothing reached the project while the child worked.
    expect(readFileSync(join(project.path, "src/a.txt"), "utf8")).toBe("alpha\n");
    end(childId, "succeeded");
    await settle();
    expect((await service.api.tree({ missionId: parentId })).children[0]?.link.integration).toBe("pending");

    const tree = await service.api.integrate({ childMissionId: childId });
    expect(tree.children[0]?.link).toMatchObject({ integration: "integrated", worktree: null });
    expect(readFileSync(join(project.path, "src/a.txt"), "utf8")).toBe("alpha from the child\n");
    expect(evaluated.map((request) => [request.operation, request.tool, request.path ?? null])).toEqual([
      ["write", "write_file", "src/a.txt"],
      ["execute", "run_tests", null],
    ]);
    expect(existsSync(root)).toBe(false);
    expect(git(project.path, "worktree", "list")).not.toContain(childId);
    expect(journal.filter((event) => event.type === "submission.updated").map((event) => event.type === "submission.updated" && event.link.integration)).toEqual([
      "pending",
      "testing",
      "integrated",
    ]);
  });

  it("integrates nothing when the child's tests fail or may not run", async () => {
    const { childId } = await startWriter();
    await childWrites(childId, "src/a.txt", "changed\n");
    await childWrites(childId, "ok.txt", "no\n");
    end(childId, "succeeded");
    await settle();
    const failed = await service.api.integrate({ childMissionId: childId });
    expect(failed.children[0]?.link.integration).toBe("tests_failed");
    expect(readFileSync(join(project.path, "src/a.txt"), "utf8")).toBe("alpha\n");

    denyTests = true;
    const refused = await service.api.integrate({ childMissionId: childId }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ServiceError);
    expect((refused as ServiceError).code).toBe("conflict");
    expect(readFileSync(join(project.path, "src/a.txt"), "utf8")).toBe("alpha\n");
  });

  it("reports a conflict when the user changed the file since the child started, overwriting nothing", async () => {
    const { childId } = await startWriter();
    await childWrites(childId, "src/a.txt", "child version\n");
    await project.write("src/a.txt", "user version\n");
    end(childId, "succeeded");
    await settle();
    const tree = await service.api.integrate({ childMissionId: childId });
    expect(tree.children[0]?.link.integration).toBe("conflict");
    expect(readFileSync(join(project.path, "src/a.txt"), "utf8")).toBe("user version\n");
    // Discarding then removes the worktree: no residue.
    const discarded = await service.api.discard({ childMissionId: childId });
    expect(discarded.children[0]?.link).toMatchObject({ integration: "discarded", worktree: null });
    expect(existsSync(join(data.path, "worktrees", childId))).toBe(false);
  });

  it("refuses background programs in a writing child: nothing would list or stop them", async () => {
    const { childId } = await startWriter();
    const deps = await service.toolDepsFor(workspaceId, childId, base());
    expect(deps.processes).toBeNull();
    await expect(
      deps.commands?.startBackground({ workspaceId, missionId: childId, argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"], cwd: "", timeoutMs: 10_000 }),
    ).rejects.toMatchObject({ code: "unavailable", message: expect.stringContaining("foreground") });
  });

  it("kills a child's foreground command when the child ends", async () => {
    const { childId } = await startWriter();
    const deps = await service.toolDepsFor(workspaceId, childId, base());
    let output = "";
    const run = deps.commands?.run(
      { workspaceId, missionId: childId, argv: [process.execPath, "-e", "console.log('pid=' + process.pid); setInterval(() => {}, 1000)"], cwd: "", timeoutMs: 60_000 },
      new AbortController().signal,
      (_stream, text) => (output += text),
    );
    const pid = async (): Promise<number> => {
      for (let attempt = 0; attempt < 500 && !/pid=\d+/.test(output); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
      return Number(/pid=(\d+)/.exec(output)?.[1] ?? -1);
    };
    const child = await pid();
    end(childId, "failed");
    await run;
    expect(alive(child)).toBe(false);
  });

  it("interrupts an integration's tests at quit: no orphan test process, the child stays « à intégrer »", async () => {
    const { childId } = await startWriter();
    await childWrites(childId, "src/a.txt", "changed\n");
    end(childId, "succeeded");
    await settle();
    const pidFile = join(data.path, "tests.pid");
    facts.testRunner = { name: "other", command: [process.execPath, "-e", `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`] };
    const integrating = service.api.integrate({ childMissionId: childId }).catch((error: unknown) => error);
    for (let attempt = 0; attempt < 500 && !existsSync(pidFile); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    const testsPid = Number(readFileSync(pidFile, "utf8"));
    expect(alive(testsPid)).toBe(true);
    await service.stopEverything();
    const outcome = await integrating;
    expect(outcome).toMatchObject({ code: "unavailable" });
    expect(alive(testsPid)).toBe(false);
    expect((await service.api.tree({ missionId: parentId })).children[0]?.link.integration).toBe("pending");
    expect(readFileSync(join(project.path, "src/a.txt"), "utf8")).toBe("alpha\n");
  });

  it("maps refusals to typed IPC errors", async () => {
    const error = await service.api.integrate({ childMissionId: "missing" }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ServiceError);
    expect((error as ServiceError).code).toBe("not_found");
  });
});
