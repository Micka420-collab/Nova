import { describe, expect, it } from "vitest";
import type { Approval, Mission, MissionEvent, MissionTask, ToolCallSummary } from "@nova/shared";
import { makeBudget, makeContract } from "../../test/atelier-fake";
import {
  applyMissionEvent,
  applyMissionEvents,
  currentTaskIndex,
  groupTimeline,
  missionFacts,
  pendingApprovals,
  proofsForFile,
  TOOL_OUTPUT_TAIL_CHARS,
  viewFromDetail,
  type MissionView,
} from "./timeline";

const MISSION_ID = "00000000-0000-4000-8000-00000000a001";
const WORKSPACE_ID = "00000000-0000-4000-8000-00000000b001";

const mission: Mission = {
  id: MISSION_ID,
  workspaceId: WORKSPACE_ID,
  conversationId: null,
  title: "Corriger le panier",
  goal: "Le total du panier est faux",
  mode: "fix",
  state: "ready",
  modelId: "vendor/model",
  createdAt: 1,
  startedAt: null,
  endedAt: null,
  updatedAt: 1,
};

type Partial1<T> = T extends unknown ? Omit<T, "id" | "seq" | "at" | "missionId"> : never;
let seq = 0;
function ev(partial: Partial1<MissionEvent>, overrides: { seq?: number } = {}): MissionEvent {
  seq = overrides.seq ?? seq + 1;
  return { id: `e-${seq}`, seq, at: 100 + seq, missionId: MISSION_ID, ...partial } as MissionEvent;
}

function call(id: string, name: ToolCallSummary["name"], partial: Partial<ToolCallSummary> = {}): ToolCallSummary {
  return { id, name, operation: "read", argumentsPreview: "{}", path: null, host: null, argv: null, ...partial };
}

function task(id: string, index: number, state: MissionTask["state"]): MissionTask {
  return { id, missionId: MISSION_ID, seq: index, title: `Étape ${index}`, state, acceptance: { kind: "manual", detail: "" } };
}

function approval(id: string, status: Approval["status"], toolCallId: string): Approval {
  return {
    id,
    request: { workspaceId: WORKSPACE_ID, missionId: MISSION_ID, tool: "run_command", operation: "execute", argv: ["pnpm", "test"] },
    decision: { decision: "ask", reason: "profile_asks", ruleId: null, rememberable: true, explanation: "Règle de test." },
    toolCallId,
    status,
    scope: status === "approved" ? "once" : null,
    createdAt: 10,
    decidedAt: status === "pending" ? null : 20,
  };
}

function run(events: MissionEvent[]): MissionView {
  let view: MissionView | undefined;
  for (const event of events) view = applyMissionEvent(view, event);
  if (!view) throw new Error("no view");
  return view;
}

function scenario(): MissionEvent[] {
  seq = 0;
  const contract = makeContract(WORKSPACE_ID);
  return [
    ev({ type: "mission.created", mission, contract }),
    ev({ type: "mission.started", contract }),
    ev({ type: "mission.plan", summary: "Deux étapes", tasks: [task("t2", 2, "todo"), task("t1", 1, "todo")] }),
    ev({ type: "task.updated", task: task("t1", 1, "running") }),
    ev({ type: "tool.requested", call: call("c1", "read_file", { path: "src/cart.ts" }), taskId: "t1" }),
    ev({ type: "tool.permission", callId: "c1", decision: { decision: "allow", reason: "contract_allows", ruleId: null, rememberable: false, explanation: "Règle de test." }, approvalId: null }),
    ev({ type: "tool.started", callId: "c1", isolationLevel: null }),
    ev({
      type: "tool.finished",
      callId: "c1",
      state: "succeeded",
      display: { kind: "file_read", path: "src/cart.ts", startLine: 1, endLine: 40, totalLines: 40 },
      durationMs: 30,
    }),
    ev({ type: "tool.requested", call: call("c2", "run_tests", { operation: "execute", argv: ["pnpm", "test"] }), taskId: "t1" }),
    ev({ type: "tool.permission", callId: "c2", decision: { decision: "ask", reason: "profile_asks", ruleId: null, rememberable: true, explanation: "Règle de test." }, approvalId: "a1" }),
    ev({ type: "approval.requested", approval: approval("a1", "pending", "c2") }),
  ];
}

describe("mission timeline reducer", () => {
  it("projects the events into tasks, tool cards and a pending approval", () => {
    const view = run(scenario());
    expect(view.mission.state).toBe("waiting_approval");
    expect(view.tasks.map((item) => item.id)).toEqual(["t1", "t2"]);
    expect(currentTaskIndex(view)).toBe(0);
    const tools = view.items.filter((item) => item.kind === "tool");
    expect(tools.map((item) => [item.id, item.state])).toEqual([
      ["c1", "succeeded"],
      ["c2", "waiting"],
    ]);
    expect(pendingApprovals(view).map((item) => item.id)).toEqual(["a1"]);
  });

  it("goes back to running when the approval is resolved, then records one terminal outcome", () => {
    const events = scenario();
    events.push(
      ev({ type: "approval.resolved", approval: approval("a1", "approved", "c2") }),
      ev({ type: "tool.started", callId: "c2", isolationLevel: "L0" }),
      ev({ type: "tool.output", callId: "c2", stream: "stdout", chunk: "✓ cart " }),
      ev({ type: "tool.output", callId: "c2", stream: "stdout", chunk: "3 tests" }),
      ev({
        type: "tool.finished",
        callId: "c2",
        state: "succeeded",
        display: { kind: "tests", runner: "vitest", passed: 3, failed: 0, skipped: 0, exitCode: 0, proofId: "p1" },
        durationMs: 2100,
      }),
      ev({ type: "mission.succeeded", summary: "Corrigé" }),
      // A second terminal event must never replace the first.
      ev({ type: "mission.cancelled", by: "system" }),
    );
    const view = run(events);
    expect(view.mission.state).toBe("succeeded");
    expect(view.outcome).toMatchObject({ type: "succeeded", summary: "Corrigé" });
    const tests = view.items.find((item) => item.kind === "tool" && item.id === "c2");
    expect(tests?.kind === "tool" && tests.output).toBe("✓ cart 3 tests");
    expect(pendingApprovals(view)).toEqual([]);
  });

  it("ignores persisted events it already applied (live then replay gives the same view)", () => {
    const events = scenario();
    const live = run(events);
    const replayed = applyMissionEvents(live, events);
    expect(replayed).toBe(live);
  });

  it("rebuilds the same view from missions.get as from the live stream", () => {
    const events = scenario();
    const live = run(events);
    const detail = {
      mission: live.mission,
      contract: live.contract ?? makeContract(WORKSPACE_ID),
      tasks: live.tasks,
      proofs: [],
      budget: makeBudget(),
      events,
    };
    const stored = viewFromDetail(detail);
    expect(stored.items).toEqual(live.items);
    expect(stored.mission.state).toBe(live.mission.state);
    expect(stored.lastSeq).toBe(live.lastSeq);
  });

  it("does not create a view from an event of an unknown mission other than its creation", () => {
    seq = 0;
    expect(applyMissionEvent(undefined, ev({ type: "mission.resumed" }))).toBeUndefined();
  });

  it("appends live message deltas and replaces them with the completed text in place", () => {
    const events = scenario();
    events.push(
      ev({ type: "message.delta", messageId: "m1", text: "Je lis " }),
      ev({ type: "message.delta", messageId: "m1", text: "le fichier." }),
    );
    const streaming = run(events);
    const message = streaming.items.at(-1);
    expect(message).toMatchObject({ kind: "message", text: "Je lis le fichier.", complete: false });
    const done = applyMissionEvent(
      streaming,
      ev({ type: "message.completed", messageId: "m1", content: "Je lis le fichier.", usage: null }),
    );
    expect(done?.items.filter((item) => item.kind === "message")).toHaveLength(1);
    expect(done?.items.at(-1)).toMatchObject({ kind: "message", complete: true, seq: message?.seq });
  });

  it("caps live tool output to its tail", () => {
    const events = scenario();
    events.push(ev({ type: "tool.output", callId: "c1", stream: "stdout", chunk: "x".repeat(TOOL_OUTPUT_TAIL_CHARS + 10) }));
    const view = run(events);
    const item = view.items.find((entry) => entry.kind === "tool" && entry.id === "c1");
    expect(item?.kind === "tool" && item.output.length).toBe(TOOL_OUTPUT_TAIL_CHARS);
  });

  it("aggregates file changes, commands and verified tasks from events only", () => {
    const events = scenario();
    const change = (callId: string, kind: "created" | "modified", path: string, additions: number) => [
      ev({ type: "tool.requested", call: call(callId, "edit_file", { operation: "write", path }), taskId: "t1" }),
      ev({
        type: "tool.finished",
        callId,
        state: "succeeded",
        display: { kind: "file_change", change: kind, path, fromPath: null, additions, deletions: 1, checkpointId: "k1" },
        durationMs: 5,
      }),
    ];
    events.push(
      ...change("e1", "created", "src/new.ts", 10),
      ...change("e2", "modified", "src/new.ts", 2),
      ...change("e3", "modified", "src/cart.ts", 4),
      ev({ type: "task.updated", task: task("t1", 1, "verified") }),
      ev({ type: "message.completed", messageId: "m9", content: "ok", usage: { promptTokens: 100, completionTokens: 20, reasoningTokens: null, cachedTokens: null, cost: null } }),
    );
    const facts = missionFacts(run(events));
    expect(facts.created).toBe(1);
    expect(facts.modified).toBe(1);
    expect(facts.files.find((file) => file.path === "src/new.ts")).toMatchObject({ change: "created", additions: 12, deletions: 2 });
    expect(facts.verified.map((item) => item.id)).toEqual(["t1"]);
    expect(facts.unverified.map((item) => item.id)).toEqual(["t2"]);
    expect(facts.tokensIn).toBe(100);
    // A message without a reported cost makes the totals a lower bound.
    expect(facts.messagesWithoutUsage).toBe(1);
  });

  it("folds runs of four or more successful calls of one kind, never failures", () => {
    const events = scenario().slice(0, 4);
    for (const id of ["r1", "r2", "r3", "r4"]) {
      events.push(ev({ type: "tool.requested", call: call(id, "read_file"), taskId: null }));
    }
    events.push(ev({ type: "tool.requested", call: call("w1", "write_file", { operation: "write" }), taskId: null }));
    const entries = groupTimeline(run(events).items);
    const group = entries.find((entry) => entry.kind === "group");
    expect(group?.kind === "group" && group.items.map((item) => item.id)).toEqual(["r1", "r2", "r3", "r4"]);
    expect(entries.at(-1)).toMatchObject({ kind: "item", item: { id: "w1" } });
  });

  it("never folds a denied or cancelled call into a group: it breaks the run and stays visible", () => {
    const events = scenario().slice(0, 4);
    for (const id of ["r1", "r2", "r3", "r4", "r5"]) {
      events.push(ev({ type: "tool.requested", call: call(id, "read_file"), taskId: null }));
    }
    const display = { kind: "error" as const, code: "permission_denied" as const, message: "refusé" };
    events.push(ev({ type: "tool.finished", callId: "r3", state: "denied", display, durationMs: 0 }));
    const entries = groupTimeline(run(events).items);
    // Two reads, the refusal, two reads: no run is long enough to fold.
    expect(entries.some((entry) => entry.kind === "group")).toBe(false);
    expect(entries).toContainEqual({ kind: "item", item: expect.objectContaining({ id: "r3", state: "denied" }) });
  });

  it("shows no empty Nomi message between the calls of turns that only called tools", () => {
    const events = scenario().slice(0, 4);
    const usage = { promptTokens: 100, completionTokens: 20, reasoningTokens: null, cachedTokens: null, cost: 0.0001 };
    for (const id of ["r1", "r2", "r3", "r4"]) {
      events.push(ev({ type: "message.completed", messageId: `m-${id}`, content: "", usage }));
      events.push(ev({ type: "tool.requested", call: call(id, "read_file"), taskId: null }));
    }
    events.push(ev({ type: "message.completed", messageId: "m-end", content: "Fini.", usage }));
    const entries = groupTimeline(run(events).items);
    expect(entries.filter((entry) => entry.kind === "item" && entry.item.kind === "message").map((entry) => entry.kind === "item" && entry.item.id)).toEqual(["m-end"]);
    // With the empty turns gone, the four reads fold into one group.
    expect(entries.find((entry) => entry.kind === "group")).toMatchObject({ kind: "group", items: [{ id: "r1" }, { id: "r2" }, { id: "r3" }, { id: "r4" }] });
  });

  it("links a proof to the files changed before it, never to a file changed after (proofs carry no task)", () => {
    const events = scenario();
    const edit = (callId: string, path: string) => [
      ev({ type: "tool.requested", call: call(callId, "edit_file", { operation: "write", path }), taskId: null }),
      ev({
        type: "tool.finished",
        callId,
        state: "succeeded",
        display: { kind: "file_change", change: "modified", path, fromPath: null, additions: 1, deletions: 1, checkpointId: "k1" },
        durationMs: 5,
      }),
    ];
    const proof = { id: "p1", missionId: MISSION_ID, taskId: null, toolCallId: "t9", kind: "test" as const, command: ["npm", "test"], exitCode: 0, summary: "code 0", outputRef: null, createdAt: 50 };
    events.push(...edit("e1", "src/cart.ts"), ev({ type: "proof.recorded", proof }), ...edit("e2", "src/format.ts"));
    const view = run(events);
    expect(proofsForFile(view, "src/cart.ts")).toEqual([proof]);
    expect(proofsForFile(view, "src/format.ts")).toEqual([]);
    expect(proofsForFile(view, "src/other.ts")).toEqual([]);
  });
});
