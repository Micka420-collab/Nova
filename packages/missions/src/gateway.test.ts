import { randomUUID } from "node:crypto";
import type { Approval, McpToolName, MissionContract, PermissionDecision, PermissionRequest, ToolName } from "@nova/shared";
import { createToolRegistry, type McpToolOffer, type ToolDeps, type WebApi } from "@nova/tools";
import { describe, expect, it } from "vitest";
import { memoryFiles } from "../../tools/src/__fixtures__/memory-files";
import { FACTS, WS, fakeTestRunner } from "./__fixtures__/harness";
import { createApprovalBridge, type ApprovalEventLike, type ApprovalServiceLike } from "./approval-bridge";
import { createToolGateway, type ApprovalGate, type ToolExecutionAudit } from "./gateway";
import type { MissionEventInput, ToolRunRequest } from "./index";
import { missionToolSet } from "./tool-set";

const ALLOW: PermissionDecision = { decision: "allow", reason: "profile_allows", ruleId: "profile:assisted", rememberable: true, explanation: "Règle de test." };
const ASK: PermissionDecision = { decision: "ask", reason: "profile_asks", ruleId: "profile:assisted", rememberable: true, explanation: "Règle de test." };

const offer = (name: string, operation: "read" | "external", permission: "allow" | "ask"): McpToolOffer => ({
  definition: { name: `mcp__srv__${name}` as McpToolName, description: "untrusted", inputSchema: { type: "object" }, operation },
  serverName: "srv",
  toolName: name,
  permission,
});

function setup(options: { mode?: MissionContract["mode"]; deps?: Partial<ToolDeps>; mcp?: McpToolOffer[]; decide?: (r: PermissionRequest) => PermissionDecision; approvals?: ApprovalGate } = {}) {
  const mode = options.mode ?? "build";
  const missionId = randomUUID();
  const memory = memoryFiles({ "a.ts": "a\n" });
  const mcpCalls: string[] = [];
  const deps: ToolDeps = {
    files: memory.api,
    facts: async () => FACTS,
    commands: fakeTestRunner(),
    git: null,
    web: null,
    mcp: {
      listToolsForModel: async () => [],
      async callTool(name, _args, context) {
        mcpCalls.push(name);
        return {
          callId: context.callId, ok: true, content: "out", display: { kind: "mcp", server: "srv", tool: name, isError: false, text: "out" },
          provenance: { source: "mcp", untrusted: true, ref: "srv" }, durationMs: 1,
        };
      },
    },
    ...options.deps,
  };
  const mcpTools = options.mcp ?? [];
  const registry = createToolRegistry({ deps, mcpTools });
  const contract: MissionContract = {
    workspaceId: WS, mode, profile: "assisted", isolationLevel: "L0", allowedOperations: [], allowedHosts: [], webSearch: true, maxDurationMs: 60_000, budgetUsd: 1,
  };
  const context = {
    workspaceId: WS, missionId, mode, contract, allowedTools: missionToolSet(mode, { webSearch: true, mcpTools }), registry, seenVersions: new Map(), tainted: false,
  };
  const events: MissionEventInput[] = [];
  const evaluated: { request: PermissionRequest; toolCallId: string }[] = [];
  const audits: ToolExecutionAudit[] = [];
  const gateway = createToolGateway({
    context: (id) => (id === missionId ? context : null),
    permissions: {
      evaluate(request, { toolCallId }) {
        evaluated.push({ request, toolCallId });
        return options.decide?.(request) ?? ALLOW;
      },
    },
    approvals: options.approvals ?? { request: () => Promise.reject(new Error("no approval expected")) },
    checkpoints: { create: (input) => ({ id: randomUUID(), ...input, missionId: input.missionId, createdAt: 0, files: [] }) },
    journal: { append: (event) => events.push(event) },
    toolCalls: { insert() {}, setDecision() {}, markRunning() {}, finish() {} },
    proofs: { insert: (input) => ({ ...input, id: randomUUID(), createdAt: 0 }) },
    audit: (entry) => audits.push(entry),
  });
  const call = (name: string, args: unknown, signal = new AbortController().signal) => {
    const request: ToolRunRequest = { id: randomUUID(), providerCallId: "p", missionId, name, rawArguments: JSON.stringify(args), requestedAt: 0 };
    return { request, result: gateway.run(request, signal) };
  };
  const finished = () => events.filter((event) => event.type === "tool.finished");
  return { call, events, evaluated, audits, mcpCalls, finished, context, memory };
}

describe("tool gateway", () => {
  it("evaluates the exact test argv with the call id, then records a proof with that argv", async () => {
    const h = setup({ mode: "verify" });
    const { request, result } = h.call("run_tests", { filter: ["cart"] });
    expect(await result).toMatchObject({ ok: true, display: { kind: "tests", proofId: expect.any(String) } });
    expect(h.evaluated).toEqual([
      { request: expect.objectContaining({ tool: "run_tests", operation: "execute", argv: ["pnpm", "vitest", "run", "--reporter=json", "cart"], mode: "verify" }), toolCallId: request.id },
    ]);
    expect(h.events.find((event) => event.type === "proof.recorded")).toMatchObject({
      proof: { kind: "test", command: ["pnpm", "vitest", "run", "--reporter=json", "cart"], exitCode: 0 },
    });
    expect(h.audits).toEqual([expect.objectContaining({ tool: "run_tests", state: "succeeded", argv: ["pnpm", "vitest", "run", "--reporter=json", "cart"] })]);
    // The argv used for proofs never travels back to the model.
    expect(await result).not.toHaveProperty("argv");
  });

  it("records a test proof without inventing counts the runner did not report", async () => {
    const h = setup({ mode: "verify", deps: { facts: async () => ({ ...FACTS, testRunner: { name: "other", command: ["npm", "test"] } }) } });
    await h.call("run_tests", {}).result;
    const proof = h.events.find((event) => event.type === "proof.recorded");
    expect(proof).toMatchObject({ proof: { kind: "test", command: ["npm", "test"], exitCode: 0, summary: "code 0" } });
  });

  it("ends a test run without a detected runner as unavailable, before any permission", async () => {
    const h = setup({ deps: { facts: async () => ({ ...FACTS, testRunner: null }) } });
    expect(await h.call("run_tests", {}).result).toMatchObject({ ok: false, display: { code: "unavailable" } });
    expect(h.evaluated).toEqual([]);
    expect(h.finished()).toMatchObject([{ state: "failed" }]);
  });

  it("lets the domain policy refuse a page the engine allows, and never fetches it", async () => {
    const fetched: string[] = [];
    const web: WebApi = {
      decide: (url) => ({ action: "deny", host: new URL(url).hostname }),
      async fetchPage(input) {
        fetched.push(input.url);
        throw new Error("unreachable");
      },
      webSearch: () => Promise.reject(new Error("unused")),
    };
    const h = setup({ deps: { web } });
    const result = await h.call("fetch_page", { url: "https://evil.example/x" }).result;
    expect(result).toMatchObject({ ok: false, display: { code: "permission_denied", message: expect.stringMatching(/domain_policy.*evil\.example/) } });
    expect(h.events.find((event) => event.type === "tool.permission")).toMatchObject({ decision: { decision: "deny", reason: "domain_policy" } });
    expect(fetched).toEqual([]);
    expect(h.finished()).toMatchObject([{ state: "denied" }]);
  });

  it("asks for an MCP tool set to ask even when the profile allows it, and runs it once approved", async () => {
    const asked: PermissionDecision[] = [];
    const approvals: ApprovalGate = {
      async request(input, options) {
        asked.push(input.decision);
        const approval: Approval = {
          id: randomUUID(), request: input.request, decision: input.decision, toolCallId: input.toolCallId, status: "pending", scope: null, createdAt: 0, decidedAt: null,
        };
        options.onPending(approval);
        return { ...approval, status: "approved", scope: "once", decidedAt: 1 };
      },
    };
    const h = setup({ mode: "understand", mcp: [offer("lookup", "read", "ask"), offer("deploy", "external", "allow")], approvals });
    expect(h.context.allowedTools.has("mcp__srv__lookup" as ToolName)).toBe(true);
    // Understand mode does not offer (nor run) an external MCP tool.
    expect(h.context.allowedTools.has("mcp__srv__deploy" as ToolName)).toBe(false);
    expect(await h.call("mcp__srv__deploy", {}).result).toMatchObject({ ok: false, display: { code: "permission_denied" } });
    expect(await h.call("mcp__srv__lookup", { q: "x" }).result).toMatchObject({ ok: true });
    expect(asked).toEqual([{ decision: "ask", reason: "mcp_tool_policy", ruleId: "owner:mcp_tool_policy", rememberable: false, explanation: "Cet outil MCP est réglé sur « Demander » : NOVA te demande à chaque appel." }]);
    expect(h.mcpCalls).toEqual(["mcp__srv__lookup"]);
    const types = h.events.map((event) => event.type);
    expect(types.indexOf("approval.requested")).toBeLessThan(types.indexOf("tool.started"));
  });

  it("stops forwarding live output once the call has finished", async () => {
    let late: ((stream: "stdout" | "stderr", chunk: string) => void) | undefined;
    const runner = fakeTestRunner();
    const h = setup({
      deps: {
        commands: {
          ...runner,
          async run(spec, signal, onOutput) {
            onOutput?.("stdout", "during token sk-or-v1-abcdefghijklmnopqrst\n");
            late = onOutput;
            return runner.run(spec, signal, onOutput);
          },
        },
      },
    });
    await h.call("run_command", { argv: ["node", "-v"] }).result;
    late?.("stdout", "after\n");
    const outputs = h.events.filter((event) => event.type === "tool.output");
    expect(outputs).toHaveLength(1);
    expect(outputs[0]).toMatchObject({ chunk: expect.not.stringContaining("sk-or-v1-abcdefghijklmnopqrst") });
  });
});

describe("approval bridge (L1 approvals service)", () => {
  function service() {
    let emit: (event: ApprovalEventLike) => void = () => undefined;
    const resolvers = new Map<string, (outcome: "approved" | "denied") => void>();
    const rows = new Map<string, Approval>();
    const cancelled: string[] = [];
    const approvals: ApprovalServiceLike = {
      request(input) {
        const approval: Approval = {
          id: randomUUID(), request: input.request, decision: input.decision, toolCallId: input.toolCallId, status: "pending", scope: null, createdAt: 0, decidedAt: null,
        };
        rows.set(approval.id, approval);
        const outcome = new Promise<"approved" | "denied">((resolve) => resolvers.set(approval.id, resolve));
        emit({ type: "approval.requested", approval });
        return outcome;
      },
      cancelMission(missionId) {
        cancelled.push(missionId);
        for (const [id, row] of rows) {
          if (row.status !== "pending") continue;
          const expired = { ...row, status: "expired" as const, decidedAt: 1 };
          rows.set(id, expired);
          emit({ type: "approval.resolved", approval: expired });
          resolvers.get(id)?.("denied");
        }
      },
    };
    const decide = (status: "approved" | "denied"): void => {
      for (const [id, row] of rows) {
        if (row.status !== "pending") continue;
        const decided = { ...row, status, scope: status === "approved" ? ("once" as const) : null, decidedAt: 1 };
        rows.set(id, decided);
        emit({ type: "approval.resolved", approval: decided });
        resolvers.get(id)?.(status === "approved" ? "approved" : "denied");
      }
    };
    return { approvals, decide, cancelled, setEmit: (fn: typeof emit) => (emit = fn) };
  }
  const request: PermissionRequest = { workspaceId: WS, missionId: "m1", tool: "write_file", operation: "write", path: "a.ts" };

  it("hands the pending and the decided approval to the waiting call, journaling nothing itself", async () => {
    const s = service();
    const journal: MissionEventInput[] = [];
    const bridge = createApprovalBridge({ approvals: s.approvals, journal: { append: (event) => journal.push(event) } });
    s.setEmit((event) => bridge.onEvent(event));
    const pending: Approval[] = [];
    const decided = bridge.gate.request(
      { request, decision: ASK, toolCallId: "call-1", missionId: "m1" },
      { signal: new AbortController().signal, onPending: (approval) => pending.push(approval) },
    );
    expect(pending).toMatchObject([{ status: "pending", toolCallId: "call-1" }]);
    s.decide("approved");
    expect(await decided).toMatchObject({ id: pending[0]?.id, status: "approved", scope: "once" });
    expect(journal).toEqual([]);
    // An approval nobody waits for (another caller) goes straight to the mission journal.
    bridge.onEvent({ type: "approval.resolved", approval: { ...(pending[0] as Approval), toolCallId: "other" } });
    expect(journal).toMatchObject([{ type: "approval.resolved", missionId: "m1" }]);
  });

  it("expires the pending approval when the mission stops", async () => {
    const s = service();
    const bridge = createApprovalBridge({ approvals: s.approvals, journal: { append: () => undefined } });
    s.setEmit((event) => bridge.onEvent(event));
    const controller = new AbortController();
    const decided = bridge.gate.request({ request, decision: ASK, toolCallId: "call-2", missionId: "m1" }, { signal: controller.signal, onPending: () => undefined });
    controller.abort();
    expect(await decided).toMatchObject({ status: "expired" });
    expect(s.cancelled).toEqual(["m1"]);
  });
});
