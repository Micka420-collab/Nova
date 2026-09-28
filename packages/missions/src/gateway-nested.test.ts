// L4 contract of the gateway: calls issued by a run_chain program re-enter the SAME pipeline
// (permission engine, journal, audit) with their parent, and executors journal lane events
// through `record`. The chain executor itself is lane L4's; a stand-in is used here.
import { randomUUID } from "node:crypto";
import type { MissionContract, PermissionDecision, PermissionRequest, ToolResult } from "@nova/shared";
import { createToolRegistry, z, type ToolExecutor, type ToolRegistry } from "@nova/tools";
import { describe, expect, it } from "vitest";
import { memoryFiles } from "../../tools/src/__fixtures__/memory-files";
import { FACTS, WS, fakeTestRunner } from "./__fixtures__/harness";
import { createToolGateway } from "./gateway";
import type { MissionEventInput } from "./index";
import { missionToolSet } from "./tool-set";

const ALLOW: PermissionDecision = { decision: "allow", reason: "profile_allows", ruleId: "profile:assisted", rememberable: true, explanation: "Règle de test." };

describe("gateway: nested calls of a « Chaîne » program", () => {
  it("evaluates every inner call, links it to its parent, and refuses nesting", async () => {
    const missionId = randomUUID();
    const base = createToolRegistry({
      deps: { files: memoryFiles({ "a.ts": "a\n" }).api, facts: async () => FACTS, commands: fakeTestRunner(), git: null, web: null, mcp: null },
    });
    const inner: ToolResult[] = [];
    const chain: ToolExecutor<{ program: string }> = {
      name: "run_chain",
      operation: "read",
      definition: { name: "run_chain", description: "stand-in", inputSchema: { type: "object" }, operation: "read" },
      argsSchema: z.object({ program: z.string() }),
      permissionFacts: () => [{}],
      checkpointPaths: () => [],
      async execute(_args, context) {
        context.record?.({ type: "chain.started", callId: context.callId, programPreview: "await nova.read_file(...)" });
        inner.push(await context.runNested!({ name: "read_file", rawArguments: '{"path":"a.ts"}' }));
        inner.push(await context.runNested!({ name: "run_chain", rawArguments: '{"program":""}' }));
        const summary = { callId: context.callId, state: "succeeded" as const, toolCalls: 1, durationMs: 1, error: null };
        context.record?.({ type: "chain.finished", summary });
        return {
          callId: context.callId, ok: true, content: "done", durationMs: 1,
          display: { kind: "chain", state: "succeeded", toolCalls: 1, durationMs: 1, resultPreview: null },
          provenance: { source: "nova", untrusted: false, ref: null },
        };
      },
    };
    const registry: ToolRegistry = {
      definitions: (allowed) => base.definitions(allowed),
      get: (name) => (name === "run_chain" ? (chain as ToolExecutor) : base.get(name)),
      parseArguments: (name, raw) => (name === "run_chain" ? { ok: true, args: JSON.parse(raw) as unknown, repaired: false } : base.parseArguments(name, raw)),
    };
    const contract: MissionContract = {
      workspaceId: WS, mode: "build", profile: "assisted", isolationLevel: "L0", allowedOperations: [], allowedHosts: [], webSearch: false, maxDurationMs: 60_000, budgetUsd: 1,
      harness: { chain: true, autoContinue: null, subMissions: null },
    };
    const context = {
      workspaceId: WS, missionId, mode: "build" as const, contract, registry, seenVersions: new Map(), tainted: false, signal: new AbortController().signal,
      allowedTools: missionToolSet("build", { webSearch: false, mcpTools: [], harness: contract.harness }),
    };
    const events: MissionEventInput[] = [];
    const evaluated: PermissionRequest[] = [];
    const inserted: { id: string; parentCallId?: string | null }[] = [];
    const gateway = createToolGateway({
      context: (id) => (id === missionId ? context : null),
      permissions: { evaluate: (request) => (evaluated.push(request), ALLOW) },
      approvals: { request: () => Promise.reject(new Error("no approval expected")) },
      checkpoints: null,
      journal: { append: (event) => events.push(event) },
      toolCalls: { insert: (input) => inserted.push(input), setDecision() {}, markRunning() {}, finish() {} },
      proofs: { insert: (input) => ({ ...input, id: randomUUID(), createdAt: 0 }) },
    });

    const outerId = randomUUID();
    const result = await gateway.run(
      { id: outerId, providerCallId: "p1", missionId, name: "run_chain", rawArguments: '{"program":"x"}', requestedAt: 0 },
      new AbortController().signal,
    );
    expect(result.ok).toBe(true);
    // The inner read went through the engine like a direct call, and is linked to its parent.
    expect(evaluated.map((request) => request.tool)).toEqual(["run_chain", "read_file"]);
    expect(inner[0]?.ok).toBe(true);
    const requested = events.flatMap((event) => (event.type === "tool.requested" ? [event.call] : []));
    expect(requested.map((call) => [call.name, call.parentCallId ?? null])).toEqual([
      ["run_chain", null],
      ["read_file", outerId],
    ]);
    expect(inserted.find((row) => row.parentCallId === outerId)).toBeDefined();
    // A program cannot start another program.
    expect(inner[1]).toMatchObject({ ok: false, display: { kind: "error", code: "permission_denied" } });
    // Lane events are journaled on the mission.
    expect(events.filter((event) => event.type.startsWith("chain.")).map((event) => [event.type, event.missionId])).toEqual([
      ["chain.started", missionId],
      ["chain.finished", missionId],
    ]);
    // One tool.finished per tool.requested, nested calls included.
    expect(events.filter((event) => event.type === "tool.finished")).toHaveLength(2);
  });
});
