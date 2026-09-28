// L8 "jusqu'à preuve": the real mission loop, a real journal, and the continuation core as the
// main side of the hook. Each test states when rounds start and why they stop, from recorded facts.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { MissionContract, MissionEvent, MissionTask, ToolDisplay, ToolResult } from "@nova/shared";
import { scriptedProxy, type ScriptedTurn } from "../__fixtures__/harness";
import type { MissionEventInput, ToolGateway } from "../index";
import { createMissionJournal, type MissionEventRecordLike } from "../journal";
import { MissionLoop } from "../loop";
import { continuationPrompt, createContinuationCore, type ContinuationSpend } from "./continuation";

const TESTS = { name: "run_tests", arguments: "{}" };
const EDIT = { name: "edit_file", arguments: '{"path":"src/cart.ts"}' };
/** One working round: a different edit each time (the loop's own no-progress detector stays quiet). */
const working = (round: number): ScriptedTurn[] => [
  { calls: [{ name: "edit_file", arguments: `{"path":"src/cart.ts","round":${round}}` }] },
  { calls: [{ name: "run_tests", arguments: `{"round":${round}}` }] },
  { text: "Fini." },
  { text: "Fini." },
];

interface Setup {
  autoContinue?: { maxRounds: number; budgetUsd: number } | null;
  tasks?: Pick<MissionTask, "title" | "acceptance">[];
  turns: ScriptedTurn[];
  /** Tests fail for the first N runs. */
  failingRuns?: number;
  /** Spend reported by the cost ledger, read at each round decision. */
  spend?: () => ContinuationSpend;
  budgetUsd?: number;
}

function toolResult(callId: string, display: ToolDisplay, ok: boolean): ToolResult {
  return { callId, ok, content: JSON.stringify(display), display, provenance: { source: "nova", untrusted: false, ref: null }, durationMs: 1 };
}

async function runMission(options: Setup) {
  const missionId = randomUUID();
  const records: MissionEventRecordLike[] = [];
  let seq = 0;
  const journal = createMissionJournal({
    store: {
      appendEvent(id, type, payload) {
        const record = { seq: ++seq, id: randomUUID(), missionId: id, type, payload, createdAt: seq };
        records.push(record);
        return record;
      },
      listEvents: (id, afterSeq = 0) => records.filter((record) => record.missionId === id && record.seq > afterSeq),
      setState: () => undefined,
    },
    push: () => undefined,
  });
  const contract: MissionContract = {
    workspaceId: "11111111-1111-4111-8111-111111111111",
    mode: "fix",
    profile: "assisted",
    isolationLevel: "L0",
    allowedOperations: ["read", "write", "execute"],
    allowedHosts: [],
    webSearch: false,
    maxDurationMs: 60_000,
    budgetUsd: options.budgetUsd ?? 1,
    harness: { chain: false, autoContinue: options.autoContinue === undefined ? { maxRounds: 3, budgetUsd: 0.5 } : options.autoContinue, subMissions: null },
  };
  const tasks: MissionTask[] = (options.tasks ?? [{ title: "Tests verts", acceptance: { kind: "test_passes", detail: "npm test" } }]).map((task, index) => ({
    ...task,
    id: randomUUID(),
    missionId,
    seq: index,
    state: "todo",
  }));
  const core = createContinuationCore({
    contractOf: (id) => (id === missionId ? contract : null),
    tasks: () => tasks,
    events: (id, afterSeq) => journalEvents(id, afterSeq),
    spend: options.spend ?? (() => ({ spentUsd: 0, reservedUsd: 0, unknownCostCalls: 0 })),
    journal,
  });
  const journalEvents = (id: string, afterSeq: number): MissionEvent[] =>
    records
      .filter((record) => record.missionId === id && record.seq > afterSeq)
      .map((record) => ({ ...(record.payload as object), id: record.id, missionId: record.missionId, seq: record.seq, at: record.createdAt, type: record.type }) as MissionEvent);

  let testRuns = 0;
  const gateway: ToolGateway = {
    async run(request) {
      const call = { id: request.id, name: request.name as "run_tests", operation: "execute" as const, argumentsPreview: "{}", path: null, host: null, argv: null };
      journal.append({ type: "tool.requested", missionId, call, taskId: null });
      let result: ToolResult;
      if (request.name === "run_tests") {
        testRuns += 1;
        const failed = testRuns <= (options.failingRuns ?? 0) ? 1 : 0;
        const display: ToolDisplay = { kind: "tests", runner: "unknown", passed: 2 - failed, failed, skipped: 0, exitCode: failed ? 1 : 0, proofId: null };
        result = { ...toolResult(request.id, display, true), content: `run ${testRuns}: ${JSON.stringify(display)}` };
      } else {
        result = toolResult(
          request.id,
          { kind: "file_change", change: "modified", path: "src/cart.ts" as never, fromPath: null, additions: 1, deletions: 1, checkpointId: null },
          true,
        );
      }
      journal.append({ type: "tool.finished", missionId, callId: request.id, state: "succeeded", display: result.display, durationMs: 1 });
      return result;
    },
  };
  const { proxy, requests } = scriptedProxy(options.turns);
  const loop = new MissionLoop({
    proxy,
    gateway,
    // The integrator's wiring: the core sees each runtime event before the journal stores it.
    sink: {
      append(event: MissionEventInput) {
        core.beforeRuntimeEvent(event);
        journal.append(event);
      },
    },
    systemPrompt: () => "system",
    limits: { retryDelayMs: 1 },
    extensions: { continuation: core.hook },
  });
  const mission = {
    id: missionId,
    workspaceId: contract.workspaceId,
    conversationId: null,
    title: "Panier",
    goal: "Le total du panier est faux",
    mode: "fix" as const,
    state: "running" as const,
    modelId: "acme/model",
    createdAt: 0,
    startedAt: 0,
    endedAt: null,
    updatedAt: 0,
  };
  const tools = [{ name: "run_tests" as const, description: "Run the tests.", inputSchema: { type: "object" as const, properties: {} }, operation: "execute" as const }];
  const done = loop.start({ mission, contract, tasks, tools, planSummary: "Corriger le total." });
  await done;
  const events = journalEvents(missionId, 0);
  const flow = events.filter((event) => event.type.startsWith("continuation.") || event.type.startsWith("mission."));
  return { core, journal, missionId, events, flow, requests, tasks, loop };
}

const summary = (flow: MissionEvent[]) =>
  flow.map((event) => {
    if (event.type === "continuation.round") return `round ${event.round}/${event.maxRounds}`;
    if (event.type === "continuation.stopped") return `stopped ${event.reason} after ${event.rounds}`;
    if (event.type === "mission.failed") return `failed ${event.reason}`;
    return event.type;
  });

describe("continuation core (jusqu'à preuve)", () => {
  it("red tests at round 0, green at round 1: one round, stopped proven, then succeeded", async () => {
    const run = await runMission({
      failingRuns: 1,
      // Round 0: red tests, a claim, the nudge, a second claim → round 1: fix, green tests, answer.
      turns: [{ calls: [TESTS] }, { text: "Fini." }, { text: "Toujours fini." }, { calls: [EDIT] }, { calls: [TESTS] }, { text: "Tests verts." }],
    });
    expect(summary(run.flow)).toEqual(["round 1/3", "stopped proven after 1", "mission.succeeded"]);
    const round = run.flow[0];
    expect(round?.type === "continuation.round" ? round.unprovenTaskIds : null).toEqual([run.tasks[0]?.id]);
    // The model receives the round's prompt with the unproven criterion.
    expect(run.requests[3]?.messages.at(-1)).toMatchObject({ role: "user", content: expect.stringContaining("Continuation round 1 of 3") });
    expect(run.requests[3]?.messages.at(-1)).toMatchObject({ content: expect.stringContaining("Tests verts: tests en échec") });
  });

  it("stops at maxRounds even while the model keeps working", async () => {
    const run = await runMission({
      autoContinue: { maxRounds: 2, budgetUsd: 0.5 },
      failingRuns: 100,
      turns: [{ calls: [TESTS] }, { text: "Fini." }, { text: "Fini." }, ...working(1), ...working(2), ...working(3)],
    });
    expect(summary(run.flow)).toEqual(["round 1/2", "round 2/2", "stopped max_rounds after 2", "failed acceptance_failed"]);
  });

  it("stops on no progress when a round ran no tool", async () => {
    const run = await runMission({
      failingRuns: 100,
      turns: [{ calls: [TESTS] }, { text: "Fini." }, { text: "Fini." }, { text: "Rien à faire." }, { text: "Vraiment fini." }],
    });
    expect(summary(run.flow)).toEqual(["round 1/3", "stopped no_progress after 1", "failed acceptance_failed"]);
  });

  it("stops on no progress when the same criteria fail the same way without any file change", async () => {
    const rerun: ScriptedTurn[] = [{ calls: [TESTS] }, { text: "Fini." }, { text: "Fini." }];
    const run = await runMission({ failingRuns: 100, turns: [...rerun, ...rerun, ...rerun] });
    expect(summary(run.flow)).toEqual(["round 1/3", "stopped no_progress after 1", "failed acceptance_failed"]);
  });

  it("stops at the spend cap counted from the first round, inside the mission budget", async () => {
    let spent = 0.2;
    const turns = [{ calls: [TESTS] }, { text: "Fini." }, { text: "Fini." }, ...working(1), ...working(2)];
    const run = await runMission({
      autoContinue: { maxRounds: 5, budgetUsd: 0.1 },
      failingRuns: 100,
      spend: () => {
        const current = { spentUsd: spent, reservedUsd: 0, unknownCostCalls: 0 };
        // Each round costs 0.06 $: under the cap after round 1, at/over it after round 2.
        spent += 0.06;
        return current;
      },
      turns,
    });
    expect(summary(run.flow)).toEqual(["round 1/5", "round 2/5", "stopped budget after 2", "failed acceptance_failed"]);
  });

  it("never starts a round past the mission budget, nor a zero cap", async () => {
    const turns: ScriptedTurn[] = [{ calls: [TESTS] }, { text: "Fini." }, { text: "Fini." }];
    const spentAll = await runMission({ failingRuns: 100, budgetUsd: 0.3, spend: () => ({ spentUsd: 0.3, reservedUsd: 0, unknownCostCalls: 0 }), turns });
    expect(summary(spentAll.flow)).toEqual(["stopped budget after 0", "failed acceptance_failed"]);
    const zeroCap = await runMission({ failingRuns: 100, autoContinue: { maxRounds: 3, budgetUsd: 0 }, turns });
    expect(summary(zeroCap.flow)).toEqual(["stopped budget after 0", "failed acceptance_failed"]);
  });

  it("treats a call of unknown cost during the rounds as an unverifiable cap", async () => {
    let unknown = 0;
    const run = await runMission({
      failingRuns: 100,
      spend: () => ({ spentUsd: 0, reservedUsd: 0, unknownCostCalls: unknown++ }),
      turns: [{ calls: [TESTS] }, { text: "Fini." }, { text: "Fini." }, ...working(1)],
    });
    expect(summary(run.flow)).toEqual(["round 1/3", "stopped budget after 1", "failed acceptance_failed"]);
  });

  it("manual-only criteria never start a round, and the option says so once", async () => {
    // A command criterion without a command is the user's to confirm, like `manual`.
    const run = await runMission({
      tasks: [
        { title: "Relire", acceptance: { kind: "manual", detail: "Relis le total." } },
        { title: "Vérifier", acceptance: { kind: "command_succeeds", detail: "" } },
      ],
      turns: [{ text: "Fini." }],
    });
    expect(summary(run.flow)).toEqual(["stopped manual_only after 0", "mission.succeeded"]);
    const off = await runMission({ autoContinue: null, tasks: [{ title: "Relire", acceptance: { kind: "manual", detail: "" } }], turns: [{ text: "Fini." }] });
    expect(summary(off.flow)).toEqual(["mission.succeeded"]);
  });

  it("the hook refuses a round for criteria it cannot prove itself", async () => {
    const appended: MissionEventInput[] = [];
    const missionId = randomUUID();
    const task: MissionTask = { id: "t1", missionId, seq: 0, title: "Relire", state: "todo", acceptance: { kind: "manual", detail: "" } };
    const core = createContinuationCore({
      contractOf: () => ({
        workspaceId: "w", mode: "fix", profile: "assisted", isolationLevel: "L0", allowedOperations: [], allowedHosts: [], webSearch: false,
        maxDurationMs: 60_000, budgetUsd: 1, harness: { chain: false, autoContinue: { maxRounds: 3, budgetUsd: 0.5 }, subMissions: null },
      }),
      tasks: () => [task],
      events: () => [],
      spend: () => ({ spentUsd: 0, reservedUsd: 0, unknownCostCalls: 0 }),
      journal: { append: (event) => (appended.push(event), null) },
    });
    expect(await core.hook.nextRound({ missionId, round: 1, open: [{ taskId: "t1", title: "Relire", reason: "à confirmer par toi" }] })).toBeNull();
    expect(appended).toEqual([{ type: "continuation.stopped", missionId, reason: "manual_only", rounds: 0 }]);
  });

  it("is off by default: no round, no continuation event", async () => {
    const run = await runMission({ autoContinue: null, failingRuns: 100, turns: [{ calls: [TESTS] }, { text: "Fini." }, { text: "Fini." }] });
    expect(summary(run.flow)).toEqual(["failed acceptance_failed"]);
  });

  it("journals the user's stop after rounds before the cancellation, and nothing for a system cancel", async () => {
    const run = await runMission({
      autoContinue: { maxRounds: 1, budgetUsd: 0.5 },
      failingRuns: 1,
      turns: [{ calls: [TESTS] }, { text: "Fini." }, { text: "Fini." }, { calls: [EDIT] }, { calls: [TESTS] }, { text: "Vert." }],
    });
    expect(summary(run.flow).at(-1)).toBe("mission.succeeded");
    // Same core, a second mission id: round journaled by hand then the user stops.
    const other = randomUUID();
    const records: MissionEventInput[] = [];
    const core = createContinuationCore({
      contractOf: () => null,
      tasks: () => [],
      events: (id) => (id === other ? [{ id: "e", missionId: other, seq: 4, at: 4, type: "continuation.round", round: 1, maxRounds: 3, unprovenTaskIds: [] }] : []),
      spend: () => ({ spentUsd: 0, reservedUsd: 0, unknownCostCalls: 0 }),
      journal: {
        append(event) {
          records.push(event);
          return null;
        },
      },
    });
    core.beforeRuntimeEvent({ type: "mission.cancelled", missionId: other, by: "system" });
    expect(records).toEqual([]);
    core.beforeRuntimeEvent({ type: "mission.cancelled", missionId: other, by: "user" });
    expect(records).toEqual([{ type: "continuation.stopped", missionId: other, reason: "user", rounds: 1 }]);
  });
});

describe("continuationPrompt", () => {
  it("lists the criteria, bounded and redacted", () => {
    const open = Array.from({ length: 25 }, (_, index) => ({ taskId: `t${index}`, title: `Étape ${index}`, reason: "tests en échec" }));
    open[0] = { taskId: "t0", title: "Clé", reason: "sk-or-v1-FAKE-TEST-KEY-not-a-real-secret-000" };
    const prompt = continuationPrompt({ round: 2, maxRounds: 4, open });
    expect(prompt).toContain("Continuation round 2 of 4");
    expect(prompt).not.toContain("0123456789abcdef0123");
    expect(prompt).toContain("… and 5 more");
    expect(prompt.split("\n").filter((line) => line.startsWith("- Étape"))).toHaveLength(19);
  });
});
