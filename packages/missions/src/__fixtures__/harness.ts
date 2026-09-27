// Test harness: the real loop, gateway, journal and tool registry over fake provider/tool APIs.
import { createHash, randomUUID } from "node:crypto";
import type {
  Approval,
  Checkpoint,
  FileContent,
  Mission,
  MissionContract,
  MissionEvent,
  MissionState,
  MissionTask,
  PermissionDecision,
  PermissionRequest,
  Proof,
  WorkMode,
  WorkspaceFacts,
} from "@nova/shared";
import { createToolRegistry, toolsForMode, type CommandOutcome, type CommandRunner, type ToolDeps, type WorkspaceFsApi } from "@nova/tools";
import { createToolGateway, type ApprovalGate, type MissionToolContext } from "../gateway";
import type { ProviderProxy, ProxyStreamEvent, ProxyStreamRequest } from "../index";
import { createMissionJournal, type MissionEventRecordLike } from "../journal";
import { MissionLoop } from "../loop";

export const WS = "11111111-1111-4111-8111-111111111111";
const hash = (text: string): string => createHash("sha256").update(text).digest("hex");

export const FACTS: WorkspaceFacts = {
  workspaceId: WS,
  detectedAt: 0,
  packageManager: "pnpm",
  languages: ["typescript"],
  frameworks: [],
  testRunner: { name: "vitest", command: ["pnpm", "vitest", "run"] },
  devCommand: null,
  buildCommand: null,
  git: false,
  instructionFiles: [],
};

export function memoryFs(initial: Record<string, string>): { fs: WorkspaceFsApi; files: Map<string, string> } {
  const files = new Map(Object.entries(initial));
  const fs: WorkspaceFsApi = {
    async list() {
      return [];
    },
    async read({ path }): Promise<FileContent> {
      const content = files.get(path);
      if (content === undefined) throw Object.assign(new Error(`${path} not found`), { code: "not_found" });
      return { path, content, hash: hash(content), size: content.length, binary: false, tooLarge: false, eol: "lf" };
    },
    async write({ path, content, expectedHash }) {
      const current = files.get(path);
      const currentHash = current === undefined ? null : hash(current);
      if (currentHash !== expectedHash) return { status: "conflict", path, currentHash };
      files.set(path, content);
      return { status: "written", path, hash: hash(content), size: content.length };
    },
    async move() {
      throw new Error("unused");
    },
    async trash() {},
    async searchText() {
      return { matches: [], truncated: false, durationMs: 0 };
    },
    async glob() {
      return { paths: [], truncated: false };
    },
    async facts() {
      return FACTS;
    },
  };
  return { fs, files };
}

/** One scripted model turn: text and/or tool calls (arguments given raw, possibly malformed). */
export interface ScriptedTurn {
  text?: string;
  calls?: { name: string; arguments: string }[];
  /** Throw this instead of answering. */
  error?: Error;
  cost?: number;
}

export function scriptedProxy(turns: ScriptedTurn[]): { proxy: ProviderProxy; requests: ProxyStreamRequest[] } {
  const requests: ProxyStreamRequest[] = [];
  let index = 0;
  const proxy: ProviderProxy = {
    stream(request, signal) {
      requests.push(structuredClone(request));
      const turn = turns[index++] ?? { text: "Terminé." };
      return (async function* (): AsyncGenerator<ProxyStreamEvent> {
        if (signal.aborted) throw Object.assign(new Error("aborted"), { code: "aborted" });
        if (turn.error) throw turn.error;
        if (turn.text) {
          // Split the text to exercise deltas.
          yield { type: "text", text: turn.text.slice(0, 3) };
          yield { type: "text", text: turn.text.slice(3) };
        }
        for (const [position, call] of (turn.calls ?? []).entries()) {
          const half = Math.floor(call.arguments.length / 2);
          yield { type: "tool_call_delta", index: position, id: `call_${index}_${position}`, name: call.name, argumentsDelta: call.arguments.slice(0, half) };
          yield { type: "tool_call_delta", index: position, id: null, name: null, argumentsDelta: call.arguments.slice(half) };
        }
        yield {
          type: "usage",
          usage: { promptTokens: 100, completionTokens: 20, reasoningTokens: null, cachedTokens: null, cost: turn.cost ?? 0.001 },
        };
        yield { type: "finish", reason: turn.calls?.length ? "tool_calls" : "stop" };
      })();
    },
  };
  return { proxy, requests };
}

export interface HarnessOptions {
  mode?: WorkMode;
  files?: Record<string, string>;
  turns: ScriptedTurn[];
  tasks?: Pick<MissionTask, "title" | "acceptance">[];
  decide?: (request: PermissionRequest) => PermissionDecision;
  approvals?: ApprovalGate;
  commands?: CommandRunner;
  maxDurationMs?: number;
}

export const ALLOW: PermissionDecision = { decision: "allow", reason: "profile_allows", ruleId: "profile:test", rememberable: true };

/** A command runner whose tests pass (vitest JSON) unless `failing` is set. */
export function fakeTestRunner(options: { failing?: boolean } = {}): CommandRunner & { calls: string[][] } {
  const calls: string[][] = [];
  const report = (failed: number): string =>
    JSON.stringify({ numTotalTests: 2, numPassedTests: 2 - failed, numFailedTests: failed, numPendingTests: 0, testResults: [] });
  return {
    calls,
    async run(spec): Promise<CommandOutcome> {
      calls.push(spec.argv);
      const failed = options.failing ? 1 : 0;
      return {
        exitCode: failed ? 1 : 0, signal: null, durationMs: 5, output: report(failed), outputBytes: 10,
        truncated: false, timedOut: false, cancelled: false, isolationLevel: "L0",
      };
    },
    async startBackground() {
      throw new Error("unused");
    },
    list: () => [],
    async stop() {},
    async stopAll() {},
  };
}

export function createHarness(options: HarnessOptions) {
  const mode = options.mode ?? "fix";
  const { fs, files } = memoryFs(options.files ?? {});
  const commands = options.commands ?? fakeTestRunner();
  const deps: ToolDeps = { fs, commands, git: null, web: null, mcp: null };
  const registry = createToolRegistry({ deps });
  const now = Date.now;

  // In-memory journal store.
  const records: MissionEventRecordLike[] = [];
  const states: MissionState[] = [];
  let seq = 0;
  const pushed: MissionEvent[] = [];
  const journal = createMissionJournal({
    store: {
      appendEvent(missionId, type, payload) {
        const record = { seq: ++seq, id: randomUUID(), missionId, type, payload, createdAt: now() };
        records.push(record);
        return record;
      },
      listEvents: (missionId) => records.filter((record) => record.missionId === missionId),
      setState: (_id, state) => states.push(state),
    },
    push: (event) => pushed.push(event),
  });

  const evaluated: PermissionRequest[] = [];
  const proofs: Proof[] = [];
  const checkpoints: Checkpoint[] = [];
  const contract: MissionContract = {
    workspaceId: WS,
    mode,
    profile: "assisted",
    isolationLevel: "L0",
    allowedOperations: ["read", "write", "delete", "execute", "network", "git_mutation", "external"],
    allowedHosts: [],
    webSearch: false,
    maxDurationMs: options.maxDurationMs ?? 60_000,
    budgetUsd: 0.5,
  };
  const missionId = randomUUID();
  const allowedTools = toolsForMode(mode, { webSearch: false, mcpTools: [] });
  const context: MissionToolContext = {
    workspaceId: WS, missionId, mode, contract, allowedTools, registry, seenVersions: new Map(), tainted: false,
  };
  const approvals: ApprovalGate = options.approvals ?? {
    async request() {
      throw new Error("no approval expected");
    },
  };
  const gateway = createToolGateway({
    context: (id) => (id === missionId ? context : null),
    permissions: {
      evaluate(request) {
        evaluated.push(request);
        return options.decide?.(request) ?? ALLOW;
      },
    },
    approvals,
    checkpoints: {
      async capture(input) {
        const checkpoint: Checkpoint = {
          id: randomUUID(), workspaceId: input.workspaceId, missionId: input.missionId, label: input.label, reason: "tool_write", createdAt: now(),
          files: input.paths.map((path) => ({ checkpointId: "x", path, beforeHash: files.has(path) ? hash(files.get(path) ?? "") : null, afterHash: null, userHashSeen: null })),
        };
        checkpoints.push(checkpoint);
        return checkpoint;
      },
    },
    journal,
    toolCalls: { insert() {}, setDecision() {}, markRunning() {}, finish() {} },
    proofs: {
      insert(input) {
        const proof: Proof = { ...input, id: randomUUID(), createdAt: now() };
        proofs.push(proof);
        return proof;
      },
    },
  });

  const { proxy, requests } = scriptedProxy(options.turns);
  const loop = new MissionLoop({
    proxy,
    gateway,
    sink: { append: (event) => void journal.append(event) },
    systemPrompt: ({ mode: m, toolNames }) => `system ${m} ${toolNames.join(",")}`,
    limits: { retryDelayMs: 1 },
  });

  const mission: Mission = {
    id: missionId, workspaceId: WS, conversationId: null, title: "Panier", goal: "Le total du panier est faux", mode, state: "running",
    modelId: "acme/model", createdAt: now(), startedAt: now(), endedAt: null, updatedAt: now(),
  };
  const tasks: MissionTask[] = (options.tasks ?? [{ title: "Tests verts", acceptance: { kind: "test_passes", detail: "cart" } }]).map((task, index) => ({
    ...task, id: randomUUID(), missionId, seq: index, state: "todo",
  }));
  const start = (): Promise<void> =>
    loop.start({ mission, contract, tasks, tools: registry.definitions(allowedTools), planSummary: "Corriger le total." });

  const events = (): MissionEvent[] => pushed;
  const types = (): string[] => pushed.filter((event) => event.seq > 0).map((event) => event.type);
  const terminals = (): MissionEvent[] => pushed.filter((event) => ["mission.succeeded", "mission.failed", "mission.cancelled"].includes(event.type));

  return { loop, start, missionId, files, requests, evaluated, proofs, checkpoints, states, events, types, terminals, journal, commands };
}

/** Resolves once `predicate` holds for the pushed events (polls the microtask queue). */
export async function until(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error("condition not reached");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

export const approvalFor = (request: PermissionRequest, decision: PermissionDecision, status: Approval["status"]): Approval => ({
  id: randomUUID(), request, decision, toolCallId: null, status, scope: status === "approved" ? "once" : null, createdAt: Date.now(), decidedAt: status === "pending" ? null : Date.now(),
});
