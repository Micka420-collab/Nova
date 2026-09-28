import type { ChainRunSummary, ToolCallSummary } from "@nova/shared";
import { describe, expect, it } from "vitest";
import type { ApprovalItem, TimelineItem, ToolItem } from "../timeline";
import { chainRunOf, initialChainView, nestChainCalls, reduceChainEvent, type ChainMissionEvent } from "./chain-view";

const base = { id: "e", missionId: "m", seq: 1, at: 10 };
const summary: ChainRunSummary = { callId: "chain-1", state: "succeeded", toolCalls: 2, durationMs: 40, error: null };

describe("chain view slice", () => {
  it("records each program then its outcome, idempotently", () => {
    const events: ChainMissionEvent[] = [
      { ...base, type: "chain.started", callId: "chain-1", programPreview: "await nova.read_file({ path: 'a' })" },
      { ...base, type: "chain.started", callId: "chain-1", programPreview: "duplicate" },
      { ...base, seq: 2, at: 50, type: "chain.finished", summary },
    ];
    const view = events.reduce(reduceChainEvent, initialChainView());
    expect(view.runs).toEqual([{ callId: "chain-1", programPreview: "await nova.read_file({ path: 'a' })", startedAt: 10, summary }]);
    expect(chainRunOf(view, "chain-1")?.summary?.state).toBe("succeeded");
    expect(chainRunOf(view, "other")).toBeNull();
  });

  it("keeps an outcome whose start is not in the log, with the program unknown", () => {
    const view = reduceChainEvent(initialChainView(), { ...base, type: "chain.finished", summary });
    expect(view.runs).toEqual([{ callId: "chain-1", programPreview: null, startedAt: null, summary }]);
  });
});

function tool(id: string, name: ToolCallSummary["name"], parentCallId?: string | null): ToolItem {
  return {
    kind: "tool", id, seq: 0, at: 0,
    call: { id, name, operation: "read", argumentsPreview: "{}", path: null, host: null, argv: null, ...(parentCallId === undefined ? {} : { parentCallId }) },
    taskId: null, permission: null, approvalId: null, state: "succeeded", isolationLevel: null, display: null, durationMs: null, output: "",
  };
}

function approval(id: string, toolCallId: string): ApprovalItem {
  return {
    kind: "approval", id, seq: 0, at: 0,
    approval: {
      id, toolCallId, status: "pending", scope: null, createdAt: 0, decidedAt: null,
      request: { workspaceId: "w", missionId: "m", tool: "write_file", operation: "write" },
      decision: { decision: "ask", reason: "profile_asks", ruleId: null, rememberable: true, explanation: "" },
    },
  };
}

describe("nestChainCalls", () => {
  it("places a program's calls and their approvals under its card, in order", () => {
    const items: TimelineItem[] = [
      tool("direct", "read_file"),
      tool("chain-1", "run_chain"),
      tool("inner-1", "read_file", "chain-1"),
      tool("inner-2", "write_file", "chain-1"),
      approval("approval-1", "inner-2"),
      approval("approval-direct", "direct"),
      tool("after", "git_status", null),
    ];
    const nested = nestChainCalls(items);
    expect(nested.items.map((item) => item.id)).toEqual(["direct", "chain-1", "approval-direct", "after"]);
    expect(nested.children.get("chain-1")?.map((item) => item.id)).toEqual(["inner-1", "inner-2", "approval-1"]);
  });

  it("never hides a call whose parent card is not in the list", () => {
    const items: TimelineItem[] = [tool("inner-1", "read_file", "chain-gone"), tool("other", "read_file")];
    const nested = nestChainCalls(items);
    expect(nested.items.map((item) => item.id)).toEqual(["inner-1", "other"]);
    expect(nested.children.size).toBe(0);
  });
});
