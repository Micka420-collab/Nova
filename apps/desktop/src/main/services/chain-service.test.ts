// ChainService end to end without Electron: the utilityProcess is replaced by an in-memory child
// that runs the REAL chain-host session (fresh V8 context), and program calls go through the REAL
// ToolGateway, tool registry and permission engine. What is checked is what L4 promises: same
// engine and approvals for every inner call, a refusal is an error for the program and never an
// effect, each call is linked to its run_chain parent, and each program gets its own killed host.
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { UtilityProcess } from "electron";
import { createToolGateway, missionToolSet, type ApprovalGate, type MissionEventInput } from "@nova/missions";
import { evaluate } from "@nova/permissions";
import type { Approval, MissionContract, PermissionRequest, PermissionRule } from "@nova/shared";
import { createToolRegistry } from "@nova/tools";
import { describe, expect, it } from "vitest";
import { memoryFiles } from "../../../../../packages/tools/src/__fixtures__/memory-files";
import { createChainHostSession } from "../../workers/chain/session";
import type { Logger } from "../logger";
import { createChainService } from "./chain-service";

const logger: Logger = { file: "/dev/null", info: () => {}, warn: () => {}, error: () => {} };
const WS = "11111111-1111-4111-8111-111111111111";

/** In-memory chain-host: the real session behind a utilityProcess-shaped object. */
class HostChild extends EventEmitter {
  readonly stdout = null;
  readonly stderr = new EventEmitter();
  killed = false;
  private readonly session = createChainHostSession({
    post: (message) => setImmediate(() => !this.killed && this.emit("message", message)),
    heapUsedBytes: () => 0,
    limits: { syncSliceMs: 500 },
  });
  constructor(private readonly options: { silent?: boolean; outOfMemory?: boolean } = {}) {
    super();
    if (!options.silent) setImmediate(() => this.emit("message", { type: "ready" }));
  }
  postMessage(message: unknown): void {
    if (this.options.outOfMemory) {
      // What V8 does when --max-old-space-size is hit: GC trace on stderr, then the process aborts.
      this.stderr.emit("data", Buffer.from("<--- Last few GCs --->\nFATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\n"));
      setImmediate(() => this.emit("exit", 133));
      return;
    }
    setImmediate(() => !this.killed && this.session.handle(message));
  }
  kill(): boolean {
    if (this.killed) return false;
    this.killed = true;
    setImmediate(() => this.emit("exit", 0));
    return true;
  }
}

function service(options: { silent?: boolean; outOfMemory?: boolean; startTimeoutMs?: number } = {}) {
  const children: HostChild[] = [];
  const forks: Electron.ForkOptions[] = [];
  const chain = createChainService({
    entry: "/app/out/main/workers/chain-host.js",
    logger,
    env: { PATH: "/usr/bin", OPENROUTER_API_KEY: "sk-or-v1-secret", NODE_OPTIONS: "--inspect" },
    ...(options.startTimeoutMs ? { startTimeoutMs: options.startTimeoutMs } : {}),
    fork: (_entry, _args, forkOptions) => {
      forks.push(forkOptions);
      const child = new HostChild(options);
      children.push(child);
      return child as unknown as UtilityProcess;
    },
  });
  return { chain, children, forks };
}

/** A mission with « Chaîne » on, over the real gateway and engine; `decide` answers approvals. */
function mission(options: { rules?: PermissionRule[]; approve?: (approval: Approval) => boolean | Promise<boolean> } = {}) {
  const { chain, children } = service();
  const files = memoryFiles({ "src/a.ts": "export const a = 1;\n", "src/b.ts": "export const b = 2;\n" });
  const registry = createToolRegistry({
    deps: { files: files.api, facts: async () => null, commands: null, git: null, web: null, mcp: null, chain },
  });
  const contract: MissionContract = {
    workspaceId: WS, mode: "build", profile: "assisted", isolationLevel: "L0", allowedOperations: ["read", "write", "delete"],
    allowedHosts: [], webSearch: false, maxDurationMs: 60_000, budgetUsd: 1,
    harness: { chain: true, autoContinue: null, subMissions: null },
  };
  const missionId = randomUUID();
  const context = {
    workspaceId: WS, missionId, mode: "build" as const, contract, registry, seenVersions: new Map(), tainted: false,
    signal: new AbortController().signal,
    allowedTools: missionToolSet("build", { webSearch: false, mcpTools: [], harness: contract.harness }),
  };
  const events: MissionEventInput[] = [];
  const evaluated: PermissionRequest[] = [];
  const audited: { tool: string; state: string; toolCallId: string }[] = [];
  const approvals: ApprovalGate = {
    async request(input, { onPending }) {
      const pending: Approval = {
        id: randomUUID(), request: input.request, decision: input.decision, toolCallId: input.toolCallId,
        status: "pending", scope: null, createdAt: 0, decidedAt: null,
      };
      onPending(pending);
      const approved = await (options.approve ?? (() => true))(pending);
      return { ...pending, status: approved ? "approved" : "denied", scope: approved ? "once" : null, decidedAt: 1 };
    },
  };
  const gateway = createToolGateway({
    context: (id) => (id === missionId ? context : null),
    permissions: {
      evaluate: (request) => {
        evaluated.push(request);
        return evaluate(request, { profile: "assisted", contract, rules: options.rules ?? [], isolationLevel: "L0", isExcludedPath: () => false });
      },
    },
    approvals,
    checkpoints: { create: (input) => ({ id: randomUUID(), ...input, createdAt: 0, files: [] }) },
    journal: { append: (event) => events.push(event) },
    toolCalls: { insert() {}, setDecision() {}, markRunning() {}, finish() {} },
    proofs: { insert: (input) => ({ ...input, id: randomUUID(), createdAt: 0 }) },
    audit: (entry) => audited.push({ tool: entry.tool, state: entry.state, toolCallId: entry.toolCallId }),
  });
  const runChain = (program: string) =>
    gateway.run(
      { id: randomUUID(), providerCallId: "p1", missionId, name: "run_chain", rawArguments: JSON.stringify({ program }), requestedAt: 0 },
      new AbortController().signal,
    );
  return { runChain, events, evaluated, audited, files, children, chain };
}

const READ_TWO_THEN_WRITE = [
  "const a = await nova.read_file({ path: 'src/a.ts' });",
  "const b = await nova.read_file({ path: 'src/b.ts' });",
  "await nova.write_file({ path: 'src/a.ts', content: 'export const a = 3;\\n' });",
  "return { read: [a.length > 0, b.length > 0] };",
].join("\n");

describe("ChainService over the real gateway", () => {
  it("runs every program call through the engine and the approval, linked to its parent", async () => {
    const asked: Approval[] = [];
    const { runChain, events, evaluated, audited, files, children } = mission({ approve: (approval) => (asked.push(approval), true) });
    const result = await runChain(READ_TWO_THEN_WRITE);

    expect(result.ok).toBe(true);
    expect(result.display).toMatchObject({ kind: "chain", state: "succeeded", toolCalls: 3, resultPreview: '{"read":[true,true]}' });
    // The engine saw the parent and each inner call, like direct calls.
    expect(evaluated.map((request) => [request.tool, request.path ?? null])).toEqual([
      ["run_chain", null],
      ["read_file", "src/a.ts"],
      ["read_file", "src/b.ts"],
      ["write_file", "src/a.ts"],
    ]);
    // The write asked on the card before any effect, then happened.
    expect(asked.map((approval) => approval.request.tool)).toEqual(["write_file"]);
    expect(files.files.get("src/a.ts")).toBe("export const a = 3;\n");
    // Timeline: three children under the run_chain card, audit of the three executions + parent.
    const requested = events.flatMap((event) => (event.type === "tool.requested" ? [event.call] : []));
    const parentId = requested[0]!.id;
    expect(requested.slice(1).map((call) => [call.name, call.parentCallId])).toEqual([
      ["read_file", parentId],
      ["read_file", parentId],
      ["write_file", parentId],
    ]);
    expect(audited.map((entry) => [entry.tool, entry.state])).toEqual([
      ["read_file", "succeeded"],
      ["read_file", "succeeded"],
      ["write_file", "succeeded"],
      ["run_chain", "succeeded"],
    ]);
    expect(events.filter((event) => event.type.startsWith("chain.")).map((event) => event.type)).toEqual(["chain.started", "chain.finished"]);
    // Inner results came from workspace files: the program's output is fenced as data.
    expect(result.provenance.untrusted).toBe(true);
    // One host for this program, killed once it ended.
    expect(children).toHaveLength(1);
    expect(children[0]!.killed).toBe(true);
  });

  it("gives a refused write to the program as an error, without effect", async () => {
    const { runChain, files, audited } = mission({ approve: () => false });
    const result = await runChain(
      "try {\n  await nova.write_file({ path: 'src/a.ts', content: 'x' });\n  return 'written';\n} catch (error) {\n  return error.message;\n}",
    );
    expect(result.ok).toBe(true);
    expect(result.content).toContain("Error (permission_denied): the user refused this action");
    expect(files.files.get("src/a.ts")).toBe("export const a = 1;\n");
    expect(files.changes).toHaveLength(0);
    expect(audited.map((entry) => [entry.tool, entry.state])).toEqual([
      ["write_file", "denied"],
      ["run_chain", "succeeded"],
    ]);
  });

  it("applies stored deny rules to program calls exactly as to direct calls", async () => {
    const deny: PermissionRule = {
      id: "rule-deny-delete", workspaceId: WS, missionId: null, tool: "delete_path", operation: null, pathGlob: null, host: null,
      decision: "deny", scope: "project", source: "user", createdAt: 0, expiresAt: null,
    };
    const { runChain, files } = mission({ rules: [deny] });
    const result = await runChain("await nova.delete_path({ path: 'src/b.ts' });\nreturn 'deleted';");
    expect(result.ok).toBe(false);
    expect(result.display).toMatchObject({ kind: "chain", state: "failed" });
    expect(result.content).toContain("permission_denied");
    expect(files.files.has("src/b.ts")).toBe(true);
  });

  it("suspends the program while an approval is pending", async () => {
    const pending: { answer: ((value: boolean) => void) | null } = { answer: null };
    const { runChain, events } = mission({ approve: () => new Promise<boolean>((resolve) => (pending.answer = resolve)) });
    const running = runChain("await nova.write_file({ path: 'src/new.ts', content: 'x' });\nreturn 'done';");
    for (let waited = 0; waited < 2_000 && !pending.answer; waited += 5) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(events.some((event) => event.type === "approval.requested")).toBe(true);
    expect(events.some((event) => event.type === "chain.finished")).toBe(false);
    pending.answer!(true);
    const result = await running;
    expect(result.display).toMatchObject({ kind: "chain", state: "succeeded", toolCalls: 1 });
  });

  it("refuses nesting run_chain from a program", async () => {
    const { runChain } = mission();
    const result = await runChain("try { await nova.run_chain({ program: 'return 1;' }); } catch (error) { return error.message; }");
    expect(result.content).toContain("cannot be called from a program");
  });
});

describe("ChainService hosts", () => {
  it("starts each host with a scrubbed environment and a heap cap", async () => {
    const { chain, forks } = service();
    const outcome = await chain.run("return 1 + 1;", {
      workspaceId: WS, missionId: "m", callId: "c", signal: new AbortController().signal, runNested: async () => Promise.reject(new Error("unused")),
    });
    expect(outcome).toMatchObject({ summary: { state: "succeeded" }, result: "2" });
    expect(forks[0]!.env).toEqual({ PATH: "/usr/bin" });
    expect(forks[0]!.execArgv).toEqual(["--js-flags=--max-old-space-size=128"]);
  });

  it("fails visibly and kills a host that never says it is ready", async () => {
    const { chain, children } = service({ silent: true, startTimeoutMs: 20 });
    const outcome = await chain.run("return 1;", {
      workspaceId: WS, missionId: "m", callId: "c", signal: new AbortController().signal, runNested: async () => Promise.reject(new Error("unused")),
    });
    expect(outcome.summary).toMatchObject({ state: "failed", error: "the program host stopped unexpectedly (code 0)" });
    expect(children[0]!.killed).toBe(true);
    expect(chain.running).toBe(0);
  });

  it("reports a host stopped by its V8 heap cap as a memory limit", async () => {
    const { chain } = service({ outOfMemory: true });
    const outcome = await chain.run("const keep = []; for (;;) keep.push(new Array(1e6).fill(1));", {
      workspaceId: WS, missionId: "m", callId: "c", signal: new AbortController().signal, runNested: async () => Promise.reject(new Error("unused")),
    });
    expect(outcome.summary).toMatchObject({ state: "limit", error: "the program used more than 64 MB of memory" });
  });

  it("answers the self-test", async () => {
    const { chain } = service();
    await expect(chain.selfTest()).resolves.toEqual({ ok: true, detail: "chain-host ok" });
  });

  it("stopAll kills the hosts still running", async () => {
    const { chain, children } = service();
    const running = chain.run("await nova.read_file({ path: 'a' });", {
      workspaceId: WS, missionId: "m", callId: "c", signal: new AbortController().signal, runNested: () => new Promise(() => {}),
    });
    for (let waited = 0; waited < 1_000 && chain.running === 0; waited += 5) await new Promise((resolve) => setTimeout(resolve, 5));
    await chain.stopAll();
    expect(children[0]!.killed).toBe(true);
    expect(chain.running).toBe(0);
    void running;
  });
});
