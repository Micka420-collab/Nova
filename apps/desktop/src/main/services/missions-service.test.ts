// End to end in main, without Electron: the real missions service (controller, journal, gateway,
// provider proxy) + the real L1 permission/approval/audit services + the real L2 file API and
// checkpoint store on a temp folder, talking to the real mission loop over an in-memory port
// (the agent-runtime side), with a scripted provider.
import { mkdtemp, readFile, realpath, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildMissionSystemPrompt } from "@nova/agent-runtime";
import { createPortPair, diffHunks, serveRuntimeChannel, type PortLike } from "@nova/missions";
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

/** Runtime ports of the current service: tests crash (close) or wedge them. */
let runtimePorts: PortLike[];

function build(options: { hang?: boolean; wedgedStop?: boolean } = {}): void {
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
      readCurrent: (_workspaceId, path, maxBytes) => readBytesOrNull(root, path, maxBytes),
    },
    isolationLevel: () => "L0",
    audit: (entry) => audit.recordToolExecution(entry),
    stopTimeoutMs: 100,
    async openRuntimePort() {
      const [mainPort, runtimePort] = createPortPair();
      serveRuntimeChannel(runtimePort, { systemPrompt: buildMissionSystemPrompt });
      runtimePorts.push(runtimePort);
      if (!options.wedgedStop) return mainPort;
      // A wedged runtime: its channel stays open but it never acts on a stop.
      return {
        ...mainPort,
        postMessage: (message: unknown) => {
          if ((message as { method?: unknown }).method !== "mission.stop") mainPort.postMessage(message);
        },
      };
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
/** Stored event types of one mission, budget refreshes (accepted after the end) left out. */
const storedTypes = (missionId: string): string[] =>
  pushed.filter((event) => event.seq > 0 && event.missionId === missionId && event.type !== "budget.updated").map((event) => event.type);

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
  runtimePorts = [];
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

  it("stop with a wedged runtime: main expires the approval before cancelling, and a later approval cannot run the tool", async () => {
    build({ wedgedStop: true });
    turns = [
      { text: PLAN },
      { calls: [{ name: "write_file", args: { path: "src/new.ts", content: "export const x = 1;\n" } }] },
    ];
    const plan = await service.api.plan({ workspaceId, conversationId: null, goal: "Ajoute x", mode: "build", modelId: MODEL, contract: null });
    await service.api.start({ missionId: plan.mission.id, tasks: null, contract: CONTRACT });
    await until(() => stored("approval.requested").length === 1);

    expect((await service.api.stop({ missionId: plan.mission.id })).state).toBe("cancelled");
    expect(await approvals.list({ workspaceId: null, missionId: null, status: "pending" })).toEqual([]);
    expect(storedTypes(plan.mission.id).slice(-3)).toEqual(["approval.resolved", "tool.finished", "mission.cancelled"]);
    expect(stored("tool.finished")).toMatchObject([{ state: "cancelled" }]);
    const [approval] = await approvals.list({ workspaceId: null, missionId: plan.mission.id, status: null });
    await expect(approvals.decide({ approvalId: approval?.id ?? "", decision: "approve", scope: "once" })).rejects.toThrow(/expired/);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await expect(readFile(join(root, "src/new.ts"), "utf8")).rejects.toThrow(/ENOENT/);
  });

  it("a runtime crash during an approval or a running command ends each call and approval before the mission fails", async () => {
    build({ hang: true });
    turns = [
      { text: PLAN },
      { calls: [{ name: "write_file", args: { path: "src/new.ts", content: "export const x = 1;\n" } }] },
    ];
    const waiting = await service.api.plan({ workspaceId, conversationId: null, goal: "Ajoute x", mode: "build", modelId: MODEL, contract: null });
    await service.api.start({ missionId: waiting.mission.id, tasks: null, contract: CONTRACT });
    await until(() => stored("approval.requested").length === 1);
    runtimePorts[0]?.close();
    await until(() => terminal().length === 1);
    expect(storedTypes(waiting.mission.id).slice(-3)).toEqual(["approval.resolved", "tool.finished", "mission.failed"]);
    expect(await approvals.list({ workspaceId: null, missionId: null, status: "pending" })).toEqual([]);

    turns = [{ text: PLAN }, { calls: [{ name: "run_tests", args: {} }] }];
    const testing = await service.api.plan({ workspaceId, conversationId: null, goal: "Vérifie", mode: "verify", modelId: MODEL, contract: null });
    const stop = autoApprove();
    await service.api.start({ missionId: testing.mission.id, tasks: null, contract: CONTRACT });
    await until(() => pushed.some((event) => event.type === "tool.started" && event.missionId === testing.mission.id));
    stop();
    runtimePorts[1]?.close();
    await until(() => terminal().length === 2);
    expect(storedTypes(testing.mission.id).slice(-2)).toEqual(["tool.finished", "mission.failed"]);
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

  it("says what is left under the cap without rounding it up (0.498 $ left is « 0,49 $ », not « 0,50 $ »)", async () => {
    build();
    turns = [{ text: PLAN }];
    const plan = await service.api.plan({ workspaceId, conversationId: null, goal: "x", mode: "fix", modelId: MODEL, contract: null });
    // The planning call reported 0.002 $ of the default 0.50 $ cap.
    expect(service.controller.budget.reserve(plan.mission.id, 1)).toEqual({ ok: false, code: "budget", message: "budget de la mission atteint (reste 0,49 $)" });
    // Under one cent, four decimals, and float noise does not eat a unit: 0.0024 − 0.002 is 0,0004.
    turns = [{ text: PLAN }];
    const tiny = await service.api.plan({ workspaceId, conversationId: null, goal: "y", mode: "fix", modelId: MODEL, contract: { ...CONTRACT, budgetUsd: 0.0024 } });
    expect(service.controller.budget.reserve(tiny.mission.id, 1)).toMatchObject({ ok: false, message: "budget de la mission atteint (reste 0,0004 $)" });
  });

  it("closes the tool calls a crash left open: a started one as interrupted (result unknown), never replayed", async () => {
    build();
    turns = [{ text: PLAN }];
    const plan = await service.api.plan({ workspaceId, conversationId: null, goal: "x", mode: "fix", modelId: MODEL, contract: null });
    const missionId = plan.mission.id;
    const call = (id: string) => ({ id, name: "run_command" as const, operation: "execute" as const, argumentsPreview: "{}", path: null, host: null, argv: ["node", "effect.js"] });
    const journal = service.controller.journal;
    journal.append({ type: "mission.started", missionId, contract: { ...CONTRACT, workspaceId, mode: "fix", isolationLevel: "L0" } });
    journal.append({ type: "tool.requested", missionId, call: call("c-started"), taskId: null });
    journal.append({ type: "tool.started", missionId, callId: "c-started", isolationLevel: "L0" });
    journal.append({ type: "tool.requested", missionId, call: call("c-queued"), taskId: null });
    pushed = [];
    build();
    const requestsBefore = requests.length;
    expect(service.controller.recoverInterrupted()).toBe(1);
    const ends = stored("tool.finished") as Extract<MissionEvent, { type: "tool.finished" }>[];
    expect(ends.map((event) => [event.callId, event.state, event.display.kind === "error" ? event.display.code : null])).toEqual([
      ["c-started", "failed", "interrupted"],
      ["c-queued", "cancelled", "cancelled"],
    ]);
    // Each call has exactly one end, before the mission's own terminal event; nothing is re-run.
    expect(pushed.map((event) => event.type).slice(-1)).toEqual(["mission.failed"]);
    expect(requests.length).toBe(requestsBefore);
    pushed = [];
    build();
    expect(service.controller.recoverInterrupted()).toBe(0);
    expect(stored("tool.finished")).toEqual([]);
  });
});
