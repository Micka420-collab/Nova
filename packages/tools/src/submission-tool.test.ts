import { describe, expect, it } from "vitest";
import type { MissionLink, ToolName } from "@nova/shared";
import { memoryFiles } from "./__fixtures__/memory-files";
import type { SubMissionStart, SubmissionsApi, ToolDeps } from "./apis";
import type { ToolExecutionContext, ToolRecordedEvent } from "./index";
import { createToolRegistry } from "./registry";

const WS = "11111111-1111-4111-8111-111111111111";

function link(overrides: Partial<MissionLink> = {}): MissionLink {
  return {
    childMissionId: "child-1",
    parentMissionId: "m",
    kind: "submission",
    forkSeq: null,
    depth: 1,
    reservedUsd: 0.2,
    worktree: null,
    integration: "not_needed",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function setup(submissions: SubmissionsApi | null) {
  const deps: ToolDeps = { files: memoryFiles().api, facts: async () => null, commands: null, git: null, web: null, mcp: null, submissions };
  const registry = createToolRegistry({ deps });
  const recorded: ToolRecordedEvent[] = [];
  const context: ToolExecutionContext = {
    workspaceId: WS,
    missionId: "m",
    callId: "call-1",
    signal: new AbortController().signal,
    checkpointId: null,
    seenVersions: new Map(),
    missionHosts: null,
    record: (event) => recorded.push(event),
  };
  const parse = (args: unknown) => registry.parseArguments("start_submission", JSON.stringify(args));
  const run = (args: unknown) => {
    const parsed = parse(args);
    if (!parsed.ok) throw new Error(parsed.error);
    const executor = registry.get("start_submission");
    if (!executor) throw new Error("start_submission not registered");
    return executor.execute(parsed.args, context);
  };
  return { registry, run, parse, recorded };
}

const ARGS = { title: "Tests du panier", goal: "Write unit tests for src/cart.ts", mode: "build", budgetUsd: 0.2 };
const ALL: ReadonlySet<ToolName> = new Set(["read_file", "start_submission"]);

describe("start_submission tool", () => {
  it("is not offered when the controller is not wired", () => {
    const { registry } = setup(null);
    expect(registry.get("start_submission")).toBeNull();
    expect(registry.definitions(ALL).map((definition) => definition.name)).toEqual(["read_file"]);
  });

  it("starts the child for THIS mission, journals it and tells the model not to wait", async () => {
    const requests: SubMissionStart[] = [];
    const { registry, run, recorded } = setup({
      async start(request) {
        requests.push(request);
        return { link: link({ worktree: "child-1", integration: null }), title: request.title };
      },
    });
    expect(registry.get("start_submission")?.operation).toBe("read");
    expect(registry.get("start_submission")?.permissionFacts(ARGS)).toEqual([{}]);
    const result = await run(ARGS);
    expect(requests).toEqual([{ parentMissionId: "m", workspaceId: WS, title: "Tests du panier", goal: ARGS.goal, mode: "build", budgetUsd: 0.2 }]);
    expect(result.ok).toBe(true);
    expect(result.content).toContain("0.20 USD reserved from your budget");
    expect(result.content).toContain("do not wait for it");
    expect(result.content).toContain("user integrates them");
    expect(result.display).toEqual({ kind: "submission", childMissionId: "child-1", title: "Tests du panier", reservedUsd: 0.2, integration: null });
    expect(recorded).toEqual([{ type: "submission.started", link: link({ worktree: "child-1", integration: null }), title: "Tests du panier" }]);
  });

  it("turns a refusal into an error the model can act on, journaling nothing", async () => {
    const { run, recorded } = setup({
      async start() {
        throw Object.assign(new Error("not enough budget left for this sub-mission: 0.0500 USD available"), { code: "conflict" });
      },
    });
    const result = await run(ARGS);
    expect(result.ok).toBe(false);
    expect(result.display).toEqual({ kind: "error", code: "conflict", message: "not enough budget left for this sub-mission: 0.0500 USD available" });
    expect(recorded).toEqual([]);
  });

  it("refuses Discuter, an empty goal and a non-positive budget before calling main", async () => {
    let called = 0;
    const { parse } = setup({
      async start() {
        called += 1;
        return { link: link(), title: "t" };
      },
    });
    expect(parse({ ...ARGS, mode: "discuss" }).ok).toBe(false);
    expect(parse({ ...ARGS, goal: "   " }).ok).toBe(false);
    expect(parse({ ...ARGS, budgetUsd: 0 }).ok).toBe(false);
    expect(parse({ ...ARGS, extra: 1 }).ok).toBe(false);
    expect(called).toBe(0);
  });
});
