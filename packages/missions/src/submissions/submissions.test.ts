// Sub-missions controller: bounds (depth, children, parallel), shared budget, narrower contract,
// worktree lifecycle and the serialized, test-gated, conflict-safe integration.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  OPERATION_CLASSES,
  WORK_MODES,
  type Mission,
  type MissionContract,
  type MissionEvent,
  type MissionLink,
  type MissionLinkKind,
  type MissionPlanRequest,
  type MissionState,
  type PermissionDecision,
  type PermissionRequest,
  type RelativePath,
  type SubMissionIntegration,
  type WorkMode,
} from "@nova/shared";
import type { MissionEventInput } from "../index";
import {
  childContractInput,
  createSubmissionsController,
  isNarrowerContract,
  SubmissionError,
  type ChildTestsOutcome,
  type SubmissionLinkStore,
  type SubmissionsController,
} from "./index";

const WS = "ws-1";
const encoder = new TextEncoder();
const bytes = (text: string): Uint8Array => encoder.encode(text);
const hash = (text: string): string => createHash("sha256").update(bytes(text)).digest("hex");

function contract(overrides: Partial<MissionContract> = {}): MissionContract {
  return {
    workspaceId: WS,
    mode: "build",
    profile: "assisted",
    isolationLevel: "L0",
    allowedOperations: [...OPERATION_CLASSES],
    allowedHosts: ["example.com"],
    webSearch: true,
    maxDurationMs: 600_000,
    budgetUsd: 1,
    harness: { chain: false, autoContinue: null, subMissions: { maxChildren: 4 } },
    ...overrides,
  };
}

interface Reservation {
  id: string;
  missionId: string;
  amount: number;
  status: "reserved" | "committed" | "released";
  settled: number;
  backsSubmission: boolean;
}

function harness(
  options: { parentContract?: MissionContract; worktrees?: boolean; tests?: () => Promise<ChildTestsOutcome>; parentTainted?: boolean; changesFail?: () => boolean } = {},
) {
  let clock = 1_000;
  let ids = 0;
  const missions = new Map<string, Mission>();
  const contracts = new Map<string, MissionContract>();
  const events: MissionEventInput[] = [];
  const planned: MissionPlanRequest[] = [];
  const startedTainted = new Map<string, boolean>();
  const reservations: Reservation[] = [];
  const childCost = new Map<string, number>();
  const project = new Map<string, string>([["src/a.txt", "alpha\n"], ["src/b.txt", "beta\n"]]);
  const worktreeFiles = new Map<string, Map<string, string>>();
  const bases = new Map<string, Map<string, string>>();
  const removed: string[] = [];
  const checkpoints: string[] = [];
  const evaluated: PermissionRequest[] = [];
  const testsLog: string[] = [];
  let decision: PermissionDecision["decision"] = "allow";
  let testsRunning = 0;
  let maxTestsRunning = 0;
  let controller: SubmissionsController | null = null;

  const setState = (id: string, state: MissionState): void => {
    const mission = missions.get(id);
    if (mission) missions.set(id, { ...mission, state });
  };
  const end = (id: string, state: "succeeded" | "failed" | "cancelled"): void => {
    setState(id, state);
    const base = { id: `e${(ids += 1)}`, missionId: id, seq: 1, at: clock };
    const event: MissionEvent =
      state === "succeeded"
        ? { ...base, type: "mission.succeeded", summary: "ok" }
        : state === "failed"
          ? { ...base, type: "mission.failed", reason: "internal", detail: null }
          : { ...base, type: "mission.cancelled", by: "user" };
    controller?.onMissionEvent(event);
  };

  const addMission = (id: string, mode: WorkMode, state: MissionState, c: MissionContract): Mission => {
    const mission: Mission = { id, workspaceId: WS, conversationId: null, title: id, goal: "g", mode, state, modelId: "acme/model", createdAt: clock, startedAt: null, endedAt: null, updatedAt: clock };
    missions.set(id, mission);
    contracts.set(id, c);
    return mission;
  };
  const parentContract = options.parentContract ?? contract();
  addMission("parent", parentContract.mode, "running", parentContract);

  const linkRows = new Map<string, MissionLink>();
  const links: SubmissionLinkStore = {
    insert(input) {
      if (linkRows.has(input.childMissionId)) throw new Error("duplicate");
      const link = { ...input, createdAt: (clock += 1), updatedAt: clock };
      linkRows.set(input.childMissionId, link);
      return link;
    },
    get: (id) => linkRows.get(id) ?? null,
    listChildren: (parent: string, kind: MissionLinkKind | null = null) =>
      [...linkRows.values()].filter((link) => link.parentMissionId === parent && (kind === null || link.kind === kind)),
    listUnsettled: () =>
      [...linkRows.values()].filter(
        (link) => link.kind === "submission" && (link.integration === null || ["pending", "testing", "tests_failed", "conflict"].includes(link.integration) || link.worktree !== null),
      ),
    setIntegration(id, integration: SubMissionIntegration) {
      const link = linkRows.get(id);
      if (!link) return null;
      const next = { ...link, integration, updatedAt: (clock += 1) };
      linkRows.set(id, next);
      return next;
    },
    setWorktree(id, worktree) {
      const link = linkRows.get(id);
      if (!link) return null;
      const next = { ...link, worktree, updatedAt: (clock += 1) };
      linkRows.set(id, next);
      return next;
    },
  };

  const open = (missionId: string): number => reservations.filter((r) => r.missionId === missionId && r.status === "reserved").reduce((sum, r) => sum + r.amount, 0);
  const committed = (missionId: string): number => reservations.filter((r) => r.missionId === missionId && r.status === "committed").reduce((sum, r) => sum + r.settled, 0);

  const worktreeApi = {
    async add(_projectRoot: string, id: string) {
      worktreeFiles.set(id, new Map(project));
      bases.set(id, new Map(project));
      return { root: `/data/worktrees/${id}`, baseSha: `base-${id}` };
    },
    async get(_projectRoot: string, id: string) {
      return worktreeFiles.has(id) ? { root: `/data/worktrees/${id}`, baseSha: `base-${id}` } : null;
    },
    async changes(info: { id: string }) {
      if (options.changesFail?.()) throw new Error("git timed out");
      const files = worktreeFiles.get(info.id) ?? new Map<string, string>();
      const base = bases.get(info.id) ?? new Map<string, string>();
      const changes: { path: RelativePath; change: "added" | "modified" | "deleted" }[] = [];
      for (const path of new Set([...files.keys(), ...base.keys()])) {
        const before = base.get(path);
        const after = files.get(path);
        if (before === after) continue;
        changes.push({ path, change: before === undefined ? "added" : after === undefined ? "deleted" : "modified" });
      }
      return { changes: changes.sort((a, b) => a.path.localeCompare(b.path)), truncated: false };
    },
    async changedInProject(_root: string, baseSha: string, paths: readonly RelativePath[]) {
      const base = bases.get(baseSha.slice("base-".length)) ?? new Map<string, string>();
      return new Set(paths.filter((path) => project.get(path) !== base.get(path)));
    },
    async remove(_root: string | null, id: string) {
      removed.push(id);
      worktreeFiles.delete(id);
    },
    async list() {
      return [...worktreeFiles.keys()];
    },
  };

  controller = createSubmissionsController({
    links,
    missions: {
      get: (id) => missions.get(id) ?? null,
      contractOf: (id) => contracts.get(id) ?? null,
      async plan(req) {
        planned.push(req);
        const id = `child-${(ids += 1)}`;
        const c = { ...contract(), ...req.contract, workspaceId: WS, mode: req.mode } as MissionContract;
        const mission = addMission(id, req.mode, "ready", c);
        const title = req.goal.split("\n")[0] ?? "";
        missions.set(id, { ...mission, title });
        // Planning costs something, on the child's own budget.
        childCost.set(id, 0.002);
        return { mission: { ...mission, title }, contract: c, tasks: [], summary: "", estimate: { minUsd: null, maxUsd: null, assumptions: "" } };
      },
      async start(req) {
        startedTainted.set(req.missionId, req.tainted);
        setState(req.missionId, "running");
        return missions.get(req.missionId) as Mission;
      },
      async stop(req) {
        const mission = missions.get(req.missionId);
        if (mission && !["succeeded", "failed", "cancelled"].includes(mission.state)) end(req.missionId, "cancelled");
        return missions.get(req.missionId) as Mission;
      },
      isTainted: (id) => id === "parent" && options.parentTainted === true,
    },
    cost: {
      reserve(input) {
        const available = (input.missionBudgetUsd ?? Infinity) - committed(input.missionId) - open(input.missionId);
        if (input.amountUsd > available) return { ok: false, reason: "budget", availableUsd: Math.max(0, available) };
        const reservation: Reservation = { id: `r${reservations.length + 1}`, missionId: input.missionId, amount: input.amountUsd, status: "reserved", settled: 0, backsSubmission: input.backsSubmission === true };
        reservations.push(reservation);
        return { ok: true, reservation: { id: reservation.id } };
      },
      settle(id, actual) {
        const reservation = reservations.find((r) => r.id === id && r.status === "reserved");
        if (reservation) Object.assign(reservation, { status: "committed", settled: actual ?? reservation.amount });
      },
      release(id) {
        const reservation = reservations.find((r) => r.id === id && r.status === "reserved");
        if (reservation) reservation.status = "released";
      },
      summary: (missionId) => ({ committedUsd: childCost.get(missionId) ?? 0, spentUsd: childCost.get(missionId) ?? 0 }),
    },
    journal: {
      append(event) {
        events.push(event);
        return null;
      },
    },
    worktrees: options.worktrees === false ? null : worktreeApi,
    projectRoot: async () => "/project",
    integration: {
      readProject: async (_ws, path) => (project.has(path) ? bytes(project.get(path) as string) : null),
      readWorktree: async (root, path) => {
        const files = worktreeFiles.get(root.split("/").at(-1) ?? "");
        return files?.has(path) ? bytes(files.get(path) as string) : null;
      },
      async evaluate(request) {
        evaluated.push(request);
        return { decision, reason: "profile_allows", ruleId: null, rememberable: false, explanation: "" };
      },
      createCheckpoint(input) {
        checkpoints.push(input.label);
        return { id: `cp-${checkpoints.length}` };
      },
      async files() {
        return {
          async writeFile(path, content, opts) {
            const current = project.get(path);
            if ((current === undefined ? null : hash(current)) !== opts.expectedHash) return { status: "conflict", path, currentHash: null };
            project.set(path, content);
            return { status: "written", path, hash: hash(content), size: content.length, created: current === undefined, additions: 1, deletions: 0, checkpointId: opts.checkpointId, excerpt: null };
          },
          async trash(path) {
            project.delete(path);
          },
        };
      },
      async runTests(input) {
        testsRunning += 1;
        maxTestsRunning = Math.max(maxTestsRunning, testsRunning);
        testsLog.push(input.missionId);
        await new Promise((resolve) => setTimeout(resolve, 5));
        testsRunning -= 1;
        return options.tests ? options.tests() : { status: "passed" };
      },
    },
    dailyLimitUsd: () => 5,
    now: () => clock,
  });

  const start = (mode: Exclude<WorkMode, "discuss"> = "build", budgetUsd = 0.1, title = "Sous-tâche") =>
    (controller as SubmissionsController).start({ parentMissionId: "parent", workspaceId: WS, title, goal: "do it", mode, budgetUsd }, new AbortController().signal);

  return {
    controller,
    missions,
    contracts,
    events,
    planned,
    startedTainted,
    reservations,
    childCost,
    project,
    worktreeFiles,
    removed,
    checkpoints,
    evaluated,
    testsLog,
    links: linkRows,
    start,
    end,
    addMission,
    setDecision: (value: PermissionDecision["decision"]) => (decision = value),
    get maxTestsRunning() {
      return maxTestsRunning;
    },
    open,
    committed,
  };
}

async function rejectsWith(promise: Promise<unknown>, code: SubmissionError["code"], message?: RegExp): Promise<void> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(SubmissionError);
  expect((error as SubmissionError).code).toBe(code);
  expect((error as SubmissionError).message).toMatch(message ?? /./);
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("sub-mission bounds", () => {
  it("refuses when the contract does not enable sub-missions", async () => {
    const h = harness({ parentContract: contract({ harness: { chain: false, autoContinue: null, subMissions: null } }) });
    await rejectsWith(h.start(), "invalid_request", /not enabled/);
    expect(h.planned).toEqual([]);
  });

  it("refuses beyond depth 1: a sub-mission never delegates", async () => {
    const h = harness();
    const { link } = await h.start("verify");
    h.missions.set("parent", { ...(h.missions.get("parent") as Mission) });
    const child = link.childMissionId;
    // Even if its contract claimed sub-missions, the link makes it a child.
    h.contracts.set(child, contract());
    await rejectsWith(
      h.controller.start({ parentMissionId: child, workspaceId: WS, title: "t", goal: "g", mode: "verify", budgetUsd: 0.01 }, new AbortController().signal),
      "invalid_request",
      /depth/,
    );
    expect(h.planned).toHaveLength(1);
  });

  it("refuses beyond maxChildren and beyond maxParallel running children", async () => {
    const one = harness({ parentContract: contract({ harness: { chain: false, autoContinue: null, subMissions: { maxChildren: 1 } } }) });
    await one.start("verify");
    await rejectsWith(one.start("verify"), "conflict", /allowed sub-mission/);

    const h = harness();
    await h.start("verify");
    await h.start("plan");
    await rejectsWith(h.start("understand"), "conflict", /already running/);
    expect(h.planned).toHaveLength(2);
  });

  it("refuses visibly when the parent's budget cannot hold the reservation, spending nothing", async () => {
    const h = harness({ parentContract: contract({ budgetUsd: 0.05 }) });
    await rejectsWith(h.start("verify", 0.2), "conflict", /not enough budget.*0\.0500 USD available/);
    expect(h.planned).toEqual([]);
    expect(h.reservations).toEqual([]);
  });
});

describe("shared budget", () => {
  it("reserves on the parent before the child starts, then settles at the child's real cost", async () => {
    const h = harness();
    const { link } = await h.start("verify", 0.3);
    expect(link.reservedUsd).toBe(0.3);
    expect(h.open("parent")).toBeCloseTo(0.3);
    // A hold, left out of the day's total while the child's own calls are counted there.
    expect(h.reservations.filter((r) => r.missionId === "parent").map((r) => r.backsSubmission)).toEqual([true]);
    h.childCost.set(link.childMissionId, 0.042);
    h.end(link.childMissionId, "succeeded");
    await flush();
    expect(h.open("parent")).toBe(0);
    expect(h.committed("parent")).toBeCloseTo(0.042);
    // The child's own contract budget is the reserved amount, never more.
    expect(h.planned[0]?.contract?.budgetUsd).toBe(0.3);
  });

  it("charges the parent even when its reservation was released by its own end first", async () => {
    const h = harness();
    const { link } = await h.start("verify", 0.3);
    for (const reservation of h.reservations) reservation.status = "released"; // parent ended: releaseOpen
    h.childCost.set(link.childMissionId, 0.01);
    h.end(link.childMissionId, "failed");
    await flush();
    expect(h.committed("parent")).toBeCloseTo(0.01);
  });
});

describe("untrusted content (W5)", () => {
  it("starts the child tainted when the parent read untrusted content: its goal is the parent model's text", async () => {
    const tainted = harness({ parentTainted: true });
    const { link } = await tainted.start("build", 0.1);
    expect(tainted.startedTainted.get(link.childMissionId)).toBe(true);

    const clean = harness();
    const second = await clean.start("build", 0.1);
    expect(clean.startedTainted.get(second.link.childMissionId)).toBe(false);
  });
});

describe("child contract", () => {
  it("is never wider than the parent's, for every pair of modes", () => {
    const refused: string[] = [];
    const wider: string[] = [];
    for (const parentMode of WORK_MODES) {
      for (const childMode of WORK_MODES) {
        if (childMode === "discuss") continue;
        const parent = contract({ mode: parentMode, allowedOperations: ["read", "write", "execute", "network", "git_mutation"], harness: { chain: true, autoContinue: { maxRounds: 3, budgetUsd: 0.2 }, subMissions: { maxChildren: 2 } } });
        const outcome = childContractInput(parent, childMode, 0.1);
        if (!outcome.ok) {
          refused.push(childMode);
          continue;
        }
        const narrower =
          isNarrowerContract({ ...outcome.input, mode: childMode }, parent) &&
          !outcome.input.allowedOperations.includes("git_mutation") &&
          outcome.input.harness?.subMissions === null &&
          outcome.input.harness.autoContinue === null;
        if (!narrower) wider.push(`${parentMode} > ${childMode}`);
      }
    }
    expect(wider).toEqual([]);
    // Only writing modes are ever refused (under a parent that cannot write).
    expect(new Set(refused)).toEqual(new Set(["build", "fix"]));
  });

  it("refuses a writing child under a parent that cannot write, and narrows execution to tests", async () => {
    const h = harness({ parentContract: contract({ mode: "verify", allowedOperations: ["read", "execute", "network"] }) });
    await rejectsWith(h.start("fix"), "invalid_request", /cannot write/);
    const narrowed = childContractInput(contract({ mode: "verify", allowedOperations: ["read", "execute"] }), "build", 0.1);
    // build would run any command; under verify (tests only) execution is dropped entirely.
    expect(narrowed).toMatchObject({ ok: false });
    const understand = childContractInput(contract({ mode: "verify", allowedOperations: ["read", "execute"] }), "understand", 0.1);
    expect(understand.ok && understand.input.allowedOperations).toEqual(["read"]);
  });

  it("refuses a writing child when worktrees are unavailable, before planning", async () => {
    const h = harness({ worktrees: false });
    await rejectsWith(h.start("build"), "unavailable", /read-only/);
    expect(h.planned).toEqual([]);
    expect(h.open("parent")).toBe(0);
  });
});

describe("worktree lifecycle", () => {
  it("runs a read-only child in place: nothing to integrate", async () => {
    const h = harness();
    const { link } = await h.start("understand");
    expect(link).toMatchObject({ worktree: null, integration: "not_needed", depth: 1, kind: "submission" });
    expect(await h.controller.workspaceRootOf(link.childMissionId)).toBeNull();
  });

  it("gives a writing child its own worktree, then marks it pending when it changed files", async () => {
    const h = harness();
    const { link, title } = await h.start("build", 0.1, "Ajouter le cache");
    expect(title).toBe("Ajouter le cache");
    const child = link.childMissionId;
    expect(link.worktree).toBe(child);
    expect(await h.controller.workspaceRootOf(child)).toBe(`/data/worktrees/${child}`);
    h.worktreeFiles.get(child)?.set("src/a.txt", "alpha 2\n");
    h.end(child, "succeeded");
    await flush();
    expect(h.links.get(child)?.integration).toBe("pending");
    const update = h.events.at(-1);
    expect(update).toMatchObject({ type: "submission.updated", missionId: "parent", childState: "succeeded", link: { integration: "pending" } });
    // Nothing reached the project.
    expect(h.project.get("src/a.txt")).toBe("alpha\n");
  });

  it("settles a child whose worktree cannot be read at its end: offered for integration, reported to the parent", async () => {
    let failing = false;
    const h = harness({ changesFail: () => failing });
    const child = (await h.start("build")).link.childMissionId;
    h.worktreeFiles.get(child)?.set("src/a.txt", "alpha 2\n");
    failing = true;
    h.end(child, "succeeded");
    await flush();
    expect(h.links.get(child)?.integration).toBe("pending");
    expect(h.events.at(-1)).toMatchObject({ type: "submission.updated", missionId: "parent", link: { integration: "pending" } });
    // Once git answers again, the user's « Intégrer » goes through.
    failing = false;
    await h.controller.integrate(child);
    expect(h.links.get(child)?.integration).toBe("integrated");
  });

  it("drops the worktree of a child that changed nothing, failed, or was discarded", async () => {
    const h = harness();
    const empty = (await h.start("build")).link.childMissionId;
    const failed = (await h.start("fix")).link.childMissionId;
    h.end(empty, "succeeded");
    h.end(failed, "failed");
    await flush();
    expect(h.links.get(empty)).toMatchObject({ integration: "not_needed", worktree: null });
    expect(h.links.get(failed)).toMatchObject({ integration: "discarded", worktree: null });
    expect(h.removed.sort()).toEqual([empty, failed].sort());
  });

  it("stops running children when the parent is stopped", async () => {
    const h = harness();
    const child = (await h.start("verify")).link.childMissionId;
    h.end("parent", "cancelled");
    await flush();
    expect(h.missions.get(child)?.state).toBe("cancelled");
  });

  it("recover removes leftover worktrees and closes children left open by a crash", async () => {
    const h = harness();
    const kept = (await h.start("build")).link.childMissionId;
    h.worktreeFiles.get(kept)?.set("src/a.txt", "x\n");
    h.end(kept, "succeeded");
    await flush();
    h.worktreeFiles.set("orphan-1", new Map());
    const crashed = (await h.start("fix")).link.childMissionId;
    h.missions.set(crashed, { ...(h.missions.get(crashed) as Mission), state: "failed" });
    const fresh = harness();
    void fresh;
    await h.controller.recover();
    expect(h.removed).toContain("orphan-1");
    expect(h.removed).not.toContain(kept);
    expect(h.links.get(crashed)).toMatchObject({ integration: "discarded", worktree: null });
  });
});

describe("integration", () => {
  async function pendingChild(h: ReturnType<typeof harness>, edit: (files: Map<string, string>) => void): Promise<string> {
    const child = (await h.start("build")).link.childMissionId;
    edit(h.worktreeFiles.get(child) as Map<string, string>);
    h.end(child, "succeeded");
    await flush();
    return child;
  }

  it("runs the tests on the worktree, then writes the changes under one restore point", async () => {
    const h = harness();
    const child = await pendingChild(h, (files) => {
      files.set("src/a.txt", "alpha 2\n");
      files.set("src/c.txt", "gamma\n");
      files.delete("src/b.txt");
    });
    const tree = await h.controller.integrate(child);
    expect(h.testsLog).toEqual([child]);
    expect(h.project.get("src/a.txt")).toBe("alpha 2\n");
    expect(h.project.get("src/c.txt")).toBe("gamma\n");
    expect(h.project.has("src/b.txt")).toBe(false);
    expect(h.checkpoints).toHaveLength(1);
    expect(h.evaluated.map((request) => [request.operation, request.path, request.missionId])).toEqual([
      ["write", "src/a.txt", child],
      ["delete", "src/b.txt", child],
      ["write", "src/c.txt", child],
    ]);
    expect(tree.children[0]?.link).toMatchObject({ integration: "integrated", worktree: null });
    expect(h.removed).toContain(child);
    expect(h.events.filter((event) => event.type === "submission.updated").map((event) => event.type === "submission.updated" && event.link.integration)).toEqual([
      "pending",
      "testing",
      "integrated",
    ]);
  });

  it("integrates exactly what was tested: files the tests create or touch are left out", async () => {
    let onTests: () => void = () => {};
    const h = harness({
      tests: async () => {
        onTests();
        return { status: "passed" };
      },
    });
    const child = await pendingChild(h, (files) => files.set("src/a.txt", "tested\n"));
    onTests = () => {
      h.worktreeFiles.get(child)?.set("coverage.txt", "report\n");
      h.worktreeFiles.get(child)?.set("src/b.txt", "touched by the tests\n");
    };
    await h.controller.integrate(child);
    expect(h.project.get("src/a.txt")).toBe("tested\n");
    expect(h.project.has("coverage.txt")).toBe(false);
    expect(h.project.get("src/b.txt")).toBe("beta\n");
  });

  it("serializes integrations: one at a time, in the order asked", async () => {
    const h = harness();
    const first = await pendingChild(h, (files) => files.set("src/a.txt", "one\n"));
    const second = await pendingChild(h, (files) => files.set("src/b.txt", "two\n"));
    await Promise.all([h.controller.integrate(second), h.controller.integrate(first)]);
    expect(h.testsLog).toEqual([second, first]);
    expect(h.maxTestsRunning).toBe(1);
    expect(h.project.get("src/a.txt")).toBe("one\n");
    expect(h.project.get("src/b.txt")).toBe("two\n");
  });

  it("reports a conflict without overwriting a file the user changed since the child started", async () => {
    const h = harness();
    const child = await pendingChild(h, (files) => {
      files.set("src/a.txt", "child\n");
      files.set("src/b.txt", "child b\n");
    });
    h.project.set("src/b.txt", "user edit\n");
    const tree = await h.controller.integrate(child);
    expect(tree.children[0]?.link.integration).toBe("conflict");
    expect(h.project.get("src/a.txt")).toBe("alpha\n");
    expect(h.project.get("src/b.txt")).toBe("user edit\n");
    expect(h.checkpoints).toEqual([]);
    // The worktree is kept: the user can retry after resolving, or discard.
    expect(h.removed).not.toContain(child);
  });

  it("integrates nothing when the tests fail, and nothing without a known test command", async () => {
    let outcome: ChildTestsOutcome = { status: "failed" };
    const h = harness({ tests: async () => outcome });
    const child = await pendingChild(h, (files) => files.set("src/a.txt", "broken\n"));
    expect((await h.controller.integrate(child)).children[0]?.link.integration).toBe("tests_failed");
    expect(h.project.get("src/a.txt")).toBe("alpha\n");
    outcome = { status: "unavailable" };
    await rejectsWith(h.controller.integrate(child), "unavailable", /no test command/);
    expect(h.links.get(child)?.integration).toBe("pending");
    outcome = { status: "passed" };
    expect((await h.controller.integrate(child)).children[0]?.link.integration).toBe("integrated");
  });

  it("writes nothing when the permission engine denies one of the files", async () => {
    const h = harness();
    const child = await pendingChild(h, (files) => files.set("src/a.txt", "x\n"));
    h.setDecision("deny");
    await rejectsWith(h.controller.integrate(child), "conflict", /permission/);
    expect(h.project.get("src/a.txt")).toBe("alpha\n");
    expect(h.checkpoints).toEqual([]);
  });

  it("refuses to integrate a running child and discards it on demand, without residue", async () => {
    const h = harness();
    const child = (await h.start("build")).link.childMissionId;
    await rejectsWith(h.controller.integrate(child), "conflict", /still running/);
    const tree = await h.controller.discard(child);
    expect(h.missions.get(child)?.state).toBe("cancelled");
    expect(tree.children[0]?.link).toMatchObject({ integration: "discarded", worktree: null });
    expect(h.removed).toContain(child);
    await rejectsWith(h.controller.integrate(child), "conflict");
  });

  it("returns the tree of a parent, and a child's own node without children", async () => {
    const h = harness();
    const { link } = await h.start("plan");
    const parentTree = await h.controller.tree("parent");
    expect(parentTree.mission.id).toBe("parent");
    expect(parentTree.link).toBeNull();
    expect(parentTree.children.map((child) => child.mission.id)).toEqual([link.childMissionId]);
    const childTree = await h.controller.tree(link.childMissionId);
    expect(childTree.link?.parentMissionId).toBe("parent");
    expect(childTree.children).toEqual([]);
    await rejectsWith(h.controller.tree("missing"), "not_found");
  });
});
