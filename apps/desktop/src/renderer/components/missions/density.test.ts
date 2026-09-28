import { describe, expect, it } from "vitest";
import type { Approval, Proof, ToolName } from "@nova/shared";
import { applyDensity } from "./density";
import { nestChainCalls } from "./harness/chain-view";
import { groupTimeline, type MessageItem, type NoticeItem, type TimelineItem, type ToolItem, type ToolItemState } from "./timeline";

const MISSION_ID = "00000000-0000-4000-8000-00000000d001";
const WORKSPACE_ID = "00000000-0000-4000-8000-00000000d002";
let seq = 0;

function tool(name: ToolName, state: ToolItemState = "succeeded"): ToolItem {
  seq += 1;
  return {
    kind: "tool", id: `t${seq}`, seq, at: seq, taskId: null, permission: null, approvalId: null, state, isolationLevel: null,
    display: null, durationMs: 5, output: "",
    call: { id: `c${seq}`, name, operation: "read", argumentsPreview: "{}", path: null, host: null, argv: null },
  };
}

function message(text: string, complete = true): MessageItem {
  seq += 1;
  return { kind: "message", id: `m${seq}`, seq, at: seq, text, complete, usage: null };
}

function notice(item: NoticeItem["notice"]): NoticeItem {
  seq += 1;
  return { kind: "notice", id: `n${seq}`, seq, at: seq, notice: item };
}

function approval(status: Approval["status"]): TimelineItem {
  seq += 1;
  const value: Approval = {
    id: `a${seq}`,
    request: { workspaceId: WORKSPACE_ID, missionId: MISSION_ID, tool: "run_command", operation: "execute", argv: ["pnpm", "build"] },
    decision: { decision: "ask", reason: "profile_asks", ruleId: null, rememberable: true, explanation: "Règle." },
    toolCallId: null, status, scope: null, createdAt: 1, decidedAt: null,
  };
  return { kind: "approval", id: value.id, seq, at: seq, approval: value };
}

const proof: Proof = {
  id: "p1", missionId: MISSION_ID, taskId: null, toolCallId: null, kind: "test", command: ["pnpm", "test"], exitCode: 0,
  summary: "12 tests verts", outputRef: null, createdAt: 1,
};

/** A realistic mission: look-ups, an edit, tests, a proof, a pending approval and the answer. */
function mission(): TimelineItem[] {
  return [
    notice({ type: "plan", summary: "Corriger le total", taskCount: 2 }),
    tool("read_file"),
    tool("search_text"),
    message(""),
    tool("list_dir"),
    tool("edit_file"),
    tool("read_file", "failed"),
    tool("run_tests"),
    notice({ type: "proof", proof }),
    approval("approved"),
    tool("run_command", "waiting"),
    approval("pending"),
    notice({ type: "suspended", reason: "budget", detail: null }),
    message("Le total est corrigé et les tests passent."),
  ];
}

const ids = (items: TimelineItem[]) => items.map((item) => item.id);

describe("applyDensity", () => {
  it("« Tout » shows every item unchanged", () => {
    const items = mission();
    const view = applyDensity(items, "all");
    expect(view.items).toEqual(items);
    expect(view.hidden).toBe(0);
  });

  it("« Étapes clés » folds successful look-ups and empty turns, keeps edits, commands, failures and decisions", () => {
    const items = mission();
    const view = applyDensity(items, "key_steps");
    const names = view.items.map((item) => (item.kind === "tool" ? `${item.call.name}:${item.state}` : item.kind));
    expect(names).toEqual([
      "notice",
      "edit_file:succeeded",
      "read_file:failed",
      "run_tests:succeeded",
      "notice",
      "approval",
      "run_command:waiting",
      "approval",
      "notice",
      "message",
    ]);
    // Three look-ups hidden; the empty tool-only turn is not a step and is not counted.
    expect(view.hidden).toBe(3);
  });

  it("« Résultat » keeps the answer and the proofs, plus what the user owes and why the mission stopped", () => {
    const items = mission();
    const view = applyDensity(items, "result");
    const expected = items.filter(
      (item) =>
        (item.kind === "notice" && (item.notice.type === "proof" || item.notice.type === "suspended")) ||
        (item.kind === "tool" && item.state === "waiting") ||
        (item.kind === "approval" && item.approval.status === "pending") ||
        item === items.at(-1),
    );
    expect(ids(view.items)).toEqual(ids(expected));
    expect(view.hidden).toBe(items.length - 1 - expected.length);
  });

  it("« Résultat » before any answer shows no message, and never an empty list with nothing hidden", () => {
    const items = [tool("read_file"), message("", false)];
    const view = applyDensity(items, "result");
    expect(view.items).toEqual([]);
    expect(view.hidden).toBe(2);
  });
});

describe("« Chaîne » programs", () => {
  const chained = (name: ToolName, state: ToolItemState, parent: string | null): ToolItem => {
    const item = tool(name, state);
    return { ...item, call: { ...item.call, operation: "execute", parentCallId: parent } };
  };

  it("keeps a run_chain card at every density while a call inside it waits for the user", () => {
    const chain = chained("run_chain", "running", null);
    const child = chained("run_command", "waiting", chain.call.id);
    const pending = approval("pending");
    const owed = pending.kind === "approval" ? { ...pending, approval: { ...pending.approval, toolCallId: child.call.id } } : pending;
    const nested = nestChainCalls([chain, child, owed]);
    expect(ids(nested.items)).toEqual([chain.id]);
    for (const density of ["result", "key_steps"] as const) {
      expect(ids(applyDensity(nested.items, density, nested.children).items)).toEqual([chain.id]);
    }
    // Nothing owed inside: « Résultat » leaves the program out, like any step.
    const done = chained("run_chain", "succeeded", null);
    const quiet = nestChainCalls([done, chained("run_command", "succeeded", done.call.id)]);
    expect(applyDensity(quiet.items, "result", quiet.children).items).toEqual([]);
  });

  it("never folds a run_chain into a group of commands: its card carries the program and its calls", () => {
    const commands = [chained("run_command", "succeeded", null), chained("run_tests", "succeeded", null), chained("run_command", "succeeded", null)];
    const chain = chained("run_chain", "running", null);
    const nested = nestChainCalls([...commands, chain, chained("run_command", "waiting", chain.call.id)]);
    // Three commands then the program: without the program, the run is too short to fold.
    const entries = groupTimeline(applyDensity(nested.items, "all", nested.children).items);
    expect(entries.map((entry) => (entry.kind === "item" ? entry.item.id : "group"))).toEqual([...ids(commands), chain.id]);
    // A long run of commands still folds, and the program stays out of it.
    const more = [...commands, chained("run_command", "succeeded", null)];
    expect(groupTimeline([...more, chain])).toEqual([
      { kind: "group", category: "terminal", items: more },
      { kind: "item", item: chain },
    ]);
  });
});
