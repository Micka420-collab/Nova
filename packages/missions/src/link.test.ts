import { randomUUID } from "node:crypto";
import type { Checkpoint, MissionEvent, MissionTask, ToolResult } from "@nova/shared";
import { errorResult } from "@nova/tools";
import { describe, expect, it } from "vitest";
import { until } from "./__fixtures__/harness";
import { createPortPair } from "./channel";
import { ProxyError, type MissionEventInput, type ProxyStreamRequest } from "./index";
import { planMission } from "./planner";
import { applyReview, buildReview } from "./review";
import { connectRuntime, serveRuntimeChannel } from "./runtime-link";

const MISSION_ID = randomUUID();

function spec(tools = [{ name: "read_file" as const, description: "r", inputSchema: { type: "object" as const }, operation: "read" as const }]) {
  const task: MissionTask = { id: randomUUID(), missionId: MISSION_ID, seq: 0, title: "t", state: "todo", acceptance: { kind: "manual", detail: "" } };
  return {
    mission: {
      id: MISSION_ID, workspaceId: randomUUID(), conversationId: null, title: "t", goal: "g", mode: "fix" as const, state: "running" as const,
      modelId: "acme/m", createdAt: 0, startedAt: 0, endedAt: null, updatedAt: 0,
    },
    contract: {
      workspaceId: "w", mode: "fix" as const, profile: "assisted" as const, isolationLevel: "L0" as const, allowedOperations: [],
      allowedHosts: [], webSearch: false, maxDurationMs: 60_000, budgetUsd: 0.5,
    },
    tasks: [task],
    tools,
    planSummary: "",
  };
}

describe("runtime link over a port", () => {
  it("runs a mission in the runtime with model and tool calls served by main", async () => {
    const [mainPort, runtimePort] = createPortPair();
    serveRuntimeChannel(runtimePort, { systemPrompt: () => "system" });
    const appended: MissionEventInput[] = [];
    const modelRequests: ProxyStreamRequest[] = [];
    let turn = 0;
    const link = connectRuntime(mainPort, {
      isRunning: (id) => id === MISSION_ID,
      appendEvent: (event) => appended.push(event),
      async streamModel(request, _signal, emit) {
        modelRequests.push(request);
        turn += 1;
        if (turn === 1) {
          emit({ type: "tool_call_delta", index: 0, id: "c1", name: "read_file", argumentsDelta: '{"path":' });
          emit({ type: "tool_call_delta", index: 0, id: null, name: null, argumentsDelta: '"a.ts"}' });
          emit({ type: "finish", reason: "tool_calls" });
        } else {
          emit({ type: "text", text: "Fini." });
          emit({ type: "finish", reason: "stop" });
        }
      },
      gateway: {
        async run(request): Promise<ToolResult> {
          expect(request.rawArguments).toBe('{"path":"a.ts"}');
          return { ...errorResult(request.id, "not_found", "absent"), ok: true, content: "contenu de a.ts" };
        },
      },
    });
    await link.start(spec());
    await until(() => appended.some((event) => event.type === "mission.succeeded"));
    expect(modelRequests[1]?.messages.at(-1)).toEqual({ role: "tool", toolCallId: "c1", content: "contenu de a.ts" });
    expect(appended.map((event) => event.type)).toEqual(["message.completed", "message.delta", "message.completed", "mission.succeeded"]);
  });

  it("maps budget refusals across the port and ignores events of missions main did not start", async () => {
    const [mainPort, runtimePort] = createPortPair();
    const { loop } = serveRuntimeChannel(runtimePort, { systemPrompt: () => "system" });
    const appended: MissionEventInput[] = [];
    let running = true;
    const link = connectRuntime(mainPort, {
      isRunning: () => running,
      appendEvent: (event) => appended.push(event),
      async streamModel() {
        throw new ProxyError("budget", "budget atteint");
      },
      gateway: { run: async (request) => errorResult(request.id, "failed", "x") },
    });
    await link.start(spec());
    await until(() => appended.some((event) => event.type === "mission.suspended"));
    expect(appended.at(-1)).toMatchObject({ type: "mission.suspended", reason: "budget", detail: "budget atteint" });
    running = false;
    link.stop(MISSION_ID);
    await loop.idle();
    // The cancelled event arrives for a mission main no longer runs: dropped.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(appended.some((event) => event.type === "mission.cancelled")).toBe(false);
  });

  it("reports the runtime going away", async () => {
    const [mainPort, runtimePort] = createPortPair();
    const link = connectRuntime(mainPort, {
      isRunning: () => true,
      appendEvent: () => undefined,
      streamModel: async () => undefined,
      gateway: { run: async (request) => errorResult(request.id, "failed", "x") },
    });
    runtimePort.close();
    await expect(link.closed).resolves.toBeUndefined();
  });
});

describe("planner", () => {
  it("repairs and validates the JSON plan, retrying once with the error", async () => {
    const answers = ["```json\n{summary: 'Corriger le panier', tasks: [{title: 'Lire cart.ts', acceptance: {kind: 'manual'}},]}\n```"];
    const requests: ProxyStreamRequest[] = [];
    const proxy = {
      stream(request: ProxyStreamRequest) {
        requests.push(request);
        const text = answers.shift() ?? "{}";
        return (async function* () {
          yield { type: "text" as const, text };
          yield { type: "finish" as const, reason: "stop" as const };
        })();
      },
    };
    const plan = await planMission({ proxy, missionId: MISSION_ID, modelId: "acme/m", goal: "g", mode: "fix", facts: null, signal: new AbortController().signal });
    expect(plan).toMatchObject({ summary: "Corriger le panier", tasks: [{ title: "Lire cart.ts", acceptance: { kind: "manual", detail: "" } }] });
    expect(requests[0]).toMatchObject({ tools: [], purpose: "plan" });

    answers.push('{"summary":"x","tasks":[]}', "pas du JSON");
    await expect(planMission({ proxy, missionId: MISSION_ID, modelId: "acme/m", goal: "g", mode: "fix", facts: null, signal: new AbortController().signal })).rejects.toThrow(/valid plan/);
    expect(requests.at(-1)?.messages.at(-1)).toMatchObject({ role: "user", content: expect.stringMatching(/not valid/) });
  });

  it("forces manual criteria in modes that cannot run commands", async () => {
    const proxy = {
      stream: () =>
        (async function* () {
          yield { type: "text" as const, text: '{"summary":"s","tasks":[{"title":"t","acceptance":{"kind":"test_passes","detail":"x"}}]}' };
        })(),
    };
    const plan = await planMission({ proxy, missionId: MISSION_ID, modelId: "acme/m", goal: "g", mode: "understand", facts: null, signal: new AbortController().signal });
    expect(plan.tasks[0]?.acceptance.kind).toBe("manual");
  });
});

describe("review", () => {
  const checkpoint = (id: string, createdAt: number, files: Checkpoint["files"]): Checkpoint => ({
    id, workspaceId: "w", missionId: "m", label: "", reason: "tool_write", createdAt, files,
  });
  const A = "a".repeat(64);
  const B = "b".repeat(64);
  const C = "c".repeat(64);
  const model = buildReview([
    checkpoint("cp2", 2, [{ checkpointId: "cp2", path: "src/a.ts", beforeHash: B, afterHash: C, userHashSeen: null }]),
    checkpoint("cp1", 1, [
      { checkpointId: "cp1", path: "src/a.ts", beforeHash: A, afterHash: B, userHashSeen: null },
      { checkpointId: "cp1", path: "same.ts", beforeHash: A, afterHash: A, userHashSeen: null },
    ]),
  ]);

  it("builds one entry per changed file from the first before to the last after", () => {
    expect(model.files).toEqual([{ path: "src/a.ts", beforeHash: A, afterHash: C, checkpointIds: ["cp1", "cp2"] }]);
  });

  it("reverts a whole file newest checkpoint first, and refuses when the user changed it", async () => {
    const restored: string[] = [];
    const fs = (current: string) => ({
      currentHash: async () => current,
      restoreFile: async (checkpointId: string, path: string) => {
        restored.push(checkpointId);
        return { status: "restored" as const, path, checkpointId };
      },
      revertHunks: async () => ({ status: "reverted" as const }),
    });
    const decisions = [{ path: "src/a.ts", hunkIndex: null, decision: "reverted" as const }];
    expect(await applyReview({ workspaceId: "w", model, decisions, fs: fs(C) })).toEqual({ applied: decisions, conflicts: [] });
    expect(restored).toEqual(["cp2", "cp1"]);
    restored.length = 0;
    expect(await applyReview({ workspaceId: "w", model, decisions, fs: fs("f".repeat(64)) })).toEqual({ applied: [], conflicts: [{ path: "src/a.ts", hunkIndex: null }] });
    expect(restored).toEqual([]);
  });

  it("reverts only the refused hunks against the original content", async () => {
    const calls: unknown[] = [];
    const result = await applyReview({
      workspaceId: "w",
      model,
      decisions: [
        { path: "src/a.ts", hunkIndex: 0, decision: "kept" },
        { path: "src/a.ts", hunkIndex: 2, decision: "reverted" },
      ],
      fs: {
        currentHash: async () => C,
        restoreFile: async () => {
          throw new Error("unused");
        },
        revertHunks: async (input) => {
          calls.push(input);
          return { status: "reverted" };
        },
      },
    });
    expect(calls).toEqual([{ workspaceId: "w", path: "src/a.ts", baseHash: A, expectedCurrentHash: C, hunkIndexes: [2] }]);
    expect(result.applied).toHaveLength(2);
  });
});

describe("journal", () => {
  it("is exported for main and replays stored events as typed events", async () => {
    const { createMissionJournal } = await import("./journal");
    const pushed: MissionEvent[] = [];
    const rows: { seq: number; id: string; missionId: string; type: string; payload: unknown; createdAt: number }[] = [];
    const states: string[] = [];
    const journal = createMissionJournal({
      store: {
        appendEvent: (missionId, type, payload) => {
          const row = { seq: rows.length + 1, id: randomUUID(), missionId, type, payload, createdAt: 5 };
          rows.push(row);
          return row;
        },
        listEvents: () => rows,
        setState: (_id, state) => states.push(state),
      },
      push: (event) => pushed.push(event),
    });
    journal.append({ type: "mission.suspended", missionId: "m", reason: "user", detail: null });
    journal.append({ type: "mission.cancelled", missionId: "m", by: "user" });
    expect(journal.append({ type: "mission.succeeded", missionId: "m", summary: "x" })).toBeNull();
    expect(journal.append({ type: "review.decided", missionId: "m", decisions: [] })).not.toBeNull();
    expect(states).toEqual(["suspended", "cancelled"]);
    expect(pushed[1]).toEqual({ type: "mission.cancelled", missionId: "m", by: "user", id: rows[1]?.id, seq: 2, at: 5 });
  });
});
