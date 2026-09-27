// End to end in main, without Electron: the real missions service (controller, journal, gateway,
// provider proxy) + the real L1 permission/approval/audit services + the real L2 file API and
// checkpoint store on a temp folder, talking to the real mission loop over an in-memory port
// (the agent-runtime side), with a scripted provider.
import { mkdtemp, readFile, realpath, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildMissionSystemPrompt } from "@nova/agent-runtime";
import { createPortPair, diffHunks, serveRuntimeChannel } from "@nova/missions";
import type { ProviderStreamEvent, StreamChatRequest } from "@nova/providers";
import type { MissionEvent, WorkspaceFacts } from "@nova/shared";
import {
  createApprovalRepo,
  createAuditRepo,
  createCheckpointRepo,
  createPolicyRepo,
  createWorkspaceRepo,
  openNovaStore,
  type NovaStore,
} from "@nova/storage";
import type { CommandRunner, ToolDeps } from "@nova/tools";
import {
  createCheckpointStore,
  createIgnoreMatcher,
  createObjectStore,
  createWorkspaceFileOps,
  readBytesOrNull,
  type CheckpointStore,
} from "@nova/workspace";
import { parseUnifiedDiff } from "../../renderer/components/diff/parse";
import { ApprovalsService } from "./approvals-service";
import { AuditService } from "./audit-service";
import { createMissionsService, createReviewFsGate, type MissionsService } from "./missions-service";
import { PermissionsService } from "./permissions-service";

const KEY = "sk-or-v1-0123456789abcdef0123456789abcdef";
const MODEL = "acme/tools";
const CART = "export function total(items: number[]) {\n  return items.length;\n}\n";
const FIXED = "export function total(items: number[]) {\n  return items.reduce((a, b) => a + b, 0);\n}\n";

type Turn = { text?: string; calls?: { name: string; args: unknown }[] };

let dir: string;
let root: string;
let store: NovaStore;
let checkpoints: CheckpointStore;
let approvals: ApprovalsService;
let service: MissionsService;
let pushed: MissionEvent[];
let turns: Turn[];
let requests: StreamChatRequest[];
let workspaceId: string;
let testRuns: string[][];

const FACTS = (id: string): WorkspaceFacts => ({
  workspaceId: id,
  detectedAt: 0,
  packageManager: "pnpm",
  languages: ["typescript"],
  frameworks: [],
  testRunner: { name: "vitest", command: ["pnpm", "vitest", "run"] },
  devCommand: null,
  buildCommand: null,
  git: false,
  instructionFiles: [],
});

async function* scripted(request: StreamChatRequest): AsyncGenerator<ProviderStreamEvent> {
  requests.push(request);
  const turn = turns.shift() ?? { text: "Terminé." };
  yield { type: "meta", servedModel: MODEL, servedProvider: "Acme", generationId: "g" };
  if (turn.text) yield { type: "text", text: turn.text };
  for (const [index, call] of (turn.calls ?? []).entries()) {
    const args = JSON.stringify(call.args);
    yield { type: "tool_call_delta", index, id: `call_${requests.length}_${index}`, name: call.name, argumentsDelta: args.slice(0, 5) };
    yield { type: "tool_call_delta", index, id: null, name: null, argumentsDelta: args.slice(5) };
  }
  yield { type: "usage", usage: { promptTokens: 100, completionTokens: 10, reasoningTokens: null, cachedTokens: null, cost: 0.002 } };
  yield { type: "finish", finishReason: turn.calls ? "tool_calls" : "stop" };
}

/** Test command that reports green vitest JSON, or hangs until stopped. */
function commands(options: { hang?: boolean } = {}): CommandRunner {
  return {
    run(spec, signal) {
      testRuns.push(spec.argv);
      const report = JSON.stringify({ numTotalTests: 2, numPassedTests: 2, numFailedTests: 0, numPendingTests: 0, testResults: [] });
      const outcome = { exitCode: 0, signal: null, durationMs: 4, output: report, outputBytes: report.length, truncated: false, timedOut: false, cancelled: false, isolationLevel: "L0" as const };
      if (!options.hang) return Promise.resolve(outcome);
      return new Promise((resolve) => signal.addEventListener("abort", () => resolve({ ...outcome, exitCode: null, cancelled: true })));
    },
    startBackground: () => Promise.reject(new Error("unused")),
    list: () => [],
    stop: async () => undefined,
    stopAll: async () => undefined,
  };
}

function build(options: { hang?: boolean } = {}): void {
  const policies = createPolicyRepo(store.db);
  const audit = new AuditService({ repo: createAuditRepo(store.db) });
  const permissions = new PermissionsService({
    policies,
    audit,
    isolation: { level: "L0" },
    contractOf: (missionId) => service.controller.contractOf(missionId),
    knownCommands: () => [["pnpm", "vitest", "run"]],
  });
  approvals = new ApprovalsService({
    approvals: createApprovalRepo(store.db),
    policies,
    audit,
    emit: (event) => service.onApprovalEvent(event),
  });
  const matcher = createIgnoreMatcher(root);
  const files = createWorkspaceFileOps({ workspaceId, root, matcher, checkpoints, rgPath: null, trash: async () => undefined });
  const runner = commands(options);
  const toolDeps: ToolDeps = { files, facts: async () => FACTS(workspaceId), commands: runner, git: null, web: null, mcp: null };
  const objects = createObjectStore(join(dir, "objects"));
  service = createMissionsService({
    store,
    provider: { streamChat: (_key, request) => scripted(request) },
    resolveApiKey: async () => KEY,
    push: (event) => pushed.push(event),
    toolDeps: async () => toolDeps,
    permissions,
    approvals,
    checkpoints: { create: (input) => checkpoints.create(input), list: async (req) => checkpoints.list(req) },
    reviewFs: createReviewFsGate({
      rootOf: async () => root,
      restoreFile: (req) => checkpoints.restoreFile({ ...req, root }),
      readObject: (hash) => objects.get(hash),
      fileOps: async () => files,
      createCheckpoint: (input) => checkpoints.create(input),
    }),
    diffFs: {
      readObject: (hash) => objects.get(hash),
      readCurrent: (_workspaceId, path) => readBytesOrNull(root, path),
    },
    isolationLevel: () => "L0",
    audit: (entry) => audit.recordToolExecution(entry),
    async openRuntimePort() {
      const [mainPort, runtimePort] = createPortPair();
      serveRuntimeChannel(runtimePort, { systemPrompt: buildMissionSystemPrompt });
      return mainPort;
    },
  });
}

async function until(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error("condition not reached");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const terminal = (): MissionEvent[] => pushed.filter((event) => ["mission.succeeded", "mission.failed", "mission.cancelled"].includes(event.type));
const stored = (type: MissionEvent["type"]): MissionEvent[] => pushed.filter((event) => event.type === type && event.seq > 0);

/** Approves every pending approval as it appears (the user clicking « Autoriser une fois »). */
function autoApprove(): () => void {
  const timer = setInterval(() => {
    void approvals.list({ workspaceId: null, missionId: null, status: "pending" }).then(async (pending) => {
      for (const approval of pending) await approvals.decide({ approvalId: approval.id, decision: "approve", scope: "once" }).catch(() => undefined);
    });
  }, 5);
  return () => clearInterval(timer);
}

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "nova-missions-")));
  root = join(dir, "project");
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src/cart.ts"), CART);
  store = openNovaStore(":memory:");
  workspaceId = createWorkspaceRepo(store.db).upsertByRootPath({ rootPath: root, name: "shop" }).id;
  checkpoints = createCheckpointStore({ index: createCheckpointRepo(store.db), objects: createObjectStore(join(dir, "objects")) });
  pushed = [];
  requests = [];
  testRuns = [];
});

afterEach(async () => {
  store.close();
  await rm(dir, { recursive: true, force: true });
});

const PLAN = JSON.stringify({ summary: "Je corrige le total puis je lance les tests.", tasks: [{ title: "Tests verts", acceptance: { kind: "test_passes", detail: "cart" } }] });
const CONTRACT = { profile: "assisted" as const, allowedOperations: ["read" as const, "write" as const, "execute" as const], allowedHosts: [], webSearch: false, maxDurationMs: 600_000, budgetUsd: 0.5 };

describe("missions service (main + runtime over a port)", () => {
  it("plans, runs read → edit → tests through permissions and approvals, succeeds, then reverts a hunk in review", async () => {
    build();
    turns = [
      { text: PLAN },
      { calls: [{ name: "read_file", args: { path: "src/cart.ts" } }] },
      { calls: [{ name: "edit_file", args: { path: "src/cart.ts", edits: [{ oldText: "return items.length;", newText: "return items.reduce((a, b) => a + b, 0);" }] } }] },
      { calls: [{ name: "run_tests", args: { filter: ["cart"] } }] },
      { text: "Le total additionne maintenant les prix." },
    ];
    const plan = await service.api.plan({ workspaceId, conversationId: null, goal: "Le total du panier est faux", mode: "fix", modelId: MODEL, contract: null });
    expect(plan.tasks).toMatchObject([{ title: "Tests verts", state: "todo", acceptance: { kind: "test_passes" } }]);
    expect(plan.mission.state).toBe("ready");

    const stop = autoApprove();
    await service.api.start({ missionId: plan.mission.id, tasks: null, contract: CONTRACT });
    await until(() => terminal().length > 0);
    stop();

    expect(terminal()).toMatchObject([{ type: "mission.succeeded", summary: "Le total additionne maintenant les prix." }]);
    expect(await readFile(join(root, "src/cart.ts"), "utf8")).toBe(FIXED);
    expect(testRuns).toEqual([["pnpm", "vitest", "run", "--reporter=json", "cart"]]);
    // Tools were resent on every step request, with the key only on main's side of the port.
    const steps = requests.slice(1);
    expect(steps).toHaveLength(4);
    for (const request of steps) expect(request.tools?.map((tool) => tool.name)).toContain("edit_file");
    // Every tool.requested has one tool.finished; one approval per asked call, journaled once.
    expect(stored("tool.finished")).toHaveLength(stored("tool.requested").length);
    // Assisted asks before the write: the approval went through L1 and was journaled once.
    expect(stored("approval.requested").length).toBeGreaterThan(0);
    expect(stored("approval.requested").length).toBe(stored("approval.resolved").length);
    const approvalIds = stored("approval.requested").map((event) => (event.type === "approval.requested" ? event.approval.id : ""));
    expect(new Set(approvalIds).size).toBe(approvalIds.length);
    expect(stored("checkpoint.created")).toHaveLength(1);

    const detail = await service.api.get({ missionId: plan.mission.id, afterSeq: 0 });
    expect(detail.mission.state).toBe("succeeded");
    expect(detail.tasks).toMatchObject([{ state: "verified" }]);
    expect(detail.proofs).toMatchObject([{ kind: "test", exitCode: 0, command: ["pnpm", "vitest", "run", "--reporter=json", "cart"] }]);
    expect(detail.budget.spentUsd).toBeCloseTo(0.01, 6);
    expect(detail.budget.reservedUsd).toBe(0);

    // missions.diff shows exactly the hunks the review reverts (parsed like the review UI does).
    const diff = await service.api.diff({ missionId: plan.mission.id });
    expect(diff.files).toMatchObject([{ path: "src/cart.ts", change: "modified", missing: null }]);
    const parsed = parseUnifiedDiff(diff.files[0]?.patch ?? "");
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.hunks).toHaveLength(diffHunks(CART, FIXED)?.length ?? -1);
    expect(parsed[0]?.hunks[0]?.lines.filter((line) => line.kind === "add").map((line) => line.text)).toEqual([
      "  return items.reduce((a, b) => a + b, 0);",
    ]);

    // Review: the mission's change is one file, before → after; reverting its only hunk restores it.
    const model = await service.controller.reviewModel(plan.mission.id);
    expect(model.files).toMatchObject([{ path: "src/cart.ts", beforeHash: expect.any(String), afterHash: expect.any(String) }]);
    const review = await service.api.review({ missionId: plan.mission.id, decisions: [{ path: "src/cart.ts", hunkIndex: 0, decision: "reverted" }] });
    expect(review).toEqual({ applied: [{ path: "src/cart.ts", hunkIndex: 0, decision: "reverted" }], conflicts: [] });
    expect(await readFile(join(root, "src/cart.ts"), "utf8")).toBe(CART);
    expect(stored("review.decided")).toHaveLength(1);
  });

  it("stop while a call waits for approval: the approval expires, nothing runs, one cancelled terminal", async () => {
    build();
    turns = [
      { text: PLAN },
      { calls: [{ name: "write_file", args: { path: "src/new.ts", content: "export const x = 1;\n" } }] },
    ];
    const plan = await service.api.plan({ workspaceId, conversationId: null, goal: "Ajoute x", mode: "build", modelId: MODEL, contract: null });
    await service.api.start({ missionId: plan.mission.id, tasks: null, contract: CONTRACT });
    await until(() => stored("approval.requested").length === 1);
    expect((await service.api.get({ missionId: plan.mission.id, afterSeq: 0 })).mission.state).toBe("waiting_approval");

    await service.api.stop({ missionId: plan.mission.id });
    await service.api.stop({ missionId: plan.mission.id });
    await until(() => stored("tool.finished").length === 1);
    expect(terminal()).toMatchObject([{ type: "mission.cancelled", by: "user" }]);
    expect(stored("tool.finished")).toMatchObject([{ state: "cancelled" }]);
    expect(stored("approval.resolved")).toMatchObject([{ approval: { status: "expired" } }]);
    expect(stored("tool.started")).toEqual([]);
    await expect(readFile(join(root, "src/new.ts"), "utf8")).rejects.toThrow(/ENOENT/);
    expect(await approvals.list({ workspaceId: null, missionId: null, status: "pending" })).toEqual([]);
  });

  it("stop during a running test command ends with exactly one terminal event", async () => {
    build({ hang: true });
    turns = [{ text: PLAN }, { calls: [{ name: "run_tests", args: {} }] }];
    const plan = await service.api.plan({ workspaceId, conversationId: null, goal: "Vérifie", mode: "verify", modelId: MODEL, contract: null });
    const stop = autoApprove();
    await service.api.start({ missionId: plan.mission.id, tasks: null, contract: CONTRACT });
    await until(() => stored("tool.started").length === 1);
    stop();
    const stopped = await service.api.stop({ missionId: plan.mission.id });
    expect(stopped.state).toBe("cancelled");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(terminal()).toHaveLength(1);
    expect(stored("tool.finished")).toMatchObject([{ state: "cancelled" }]);
  });

  it("marks missions interrupted by a previous run as failed at startup", async () => {
    build();
    turns = [{ text: PLAN }];
    const plan = await service.api.plan({ workspaceId, conversationId: null, goal: "x", mode: "fix", modelId: MODEL, contract: null });
    service.controller.journal.append({ type: "mission.started", missionId: plan.mission.id, contract: { ...CONTRACT, workspaceId, mode: "fix", isolationLevel: "L0" } });
    // A new process: fresh service over the same database.
    pushed = [];
    build();
    expect(service.controller.recoverInterrupted()).toBe(1);
    expect(terminal()).toMatchObject([{ type: "mission.failed", reason: "internal" }]);
    expect(service.controller.recoverInterrupted()).toBe(0);
  });
});
