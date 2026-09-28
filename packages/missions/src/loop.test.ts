import type { CommandOutcome, CommandRunner } from "@nova/tools";
import { describe, expect, it } from "vitest";
import { ALLOW, approvalFor, createHarness, fakeTestRunner, until } from "./__fixtures__/harness";
import { ProxyError } from "./index";

const CART = "export function total(items: number[]) {\n  return items.length;\n}\n";
const READ = { name: "read_file", arguments: '{"path":"src/cart.ts"}' };
const EDIT = {
  name: "edit_file",
  arguments: JSON.stringify({ path: "src/cart.ts", edits: [{ oldText: "return items.length;", newText: "return items.reduce((a, b) => a + b, 0);" }] }),
};
const TESTS = { name: "run_tests", arguments: '{"filter":["cart"]}' };

/** Every tool.requested has exactly one tool.finished, and there is exactly one terminal event. */
function expectInvariants(h: ReturnType<typeof createHarness>): void {
  const requested = h.events().filter((event) => event.type === "tool.requested").map((event) => (event.type === "tool.requested" ? event.call.id : ""));
  const finished = h.events().filter((event) => event.type === "tool.finished").map((event) => (event.type === "tool.finished" ? event.callId : ""));
  expect(finished.sort()).toEqual(requested.sort());
  expect(h.terminals()).toHaveLength(1);
}

describe("mission loop", () => {
  it("reads, edits, runs the tests and succeeds only with a passing test proof", async () => {
    const h = createHarness({
      files: { "src/cart.ts": CART },
      turns: [{ calls: [READ] }, { calls: [EDIT] }, { calls: [TESTS] }, { text: "Le total additionne maintenant les prix." }],
    });
    await h.start();
    expect(h.files.get("src/cart.ts")).toContain("reduce");
    expect(h.terminals()[0]).toMatchObject({ type: "mission.succeeded", summary: "Le total additionne maintenant les prix." });
    expectInvariants(h);
    // Checkpoint before the write, proof after the tests, task verified.
    const types = h.types();
    expect(types.indexOf("checkpoint.created")).toBeLessThan(types.indexOf("tool.started", types.indexOf("checkpoint.created")));
    expect(h.checkpoints).toHaveLength(1);
    // The file API recorded the change into the restore point created for this call.
    expect(h.changes).toEqual([{ path: "src/cart.ts", checkpointId: h.checkpoints[0]?.id }]);
    expect(h.proofs).toMatchObject([{ kind: "test", exitCode: 0, command: ["pnpm", "vitest", "run", "--reporter=json", "cart"] }]);
    expect(h.events().some((event) => event.type === "task.updated" && event.task.state === "verified")).toBe(true);
    // Tools are resent on every request, and results travel back with their call ids.
    expect(h.requests).toHaveLength(4);
    for (const request of h.requests) expect(request.tools.map((tool) => tool.name)).toContain("edit_file");
    const last = h.requests.at(-1)?.messages ?? [];
    expect(last.filter((message) => message.role === "tool")).toHaveLength(3);
    expect(last.find((message) => message.role === "assistant" && message.toolCalls.length > 0)).toMatchObject({
      toolCalls: [{ id: "call_1_0", name: "read_file", arguments: '{"path":"src/cart.ts"}' }],
    });
    // Live deltas are pushed but never stored.
    expect(h.events().filter((event) => event.type === "message.delta").every((event) => event.seq === 0)).toBe(true);
  });

  it("fails when the latest tests fail, even if the model claims success", async () => {
    const h = createHarness({
      files: { "src/cart.ts": CART },
      commands: fakeTestRunner({ failing: true }),
      turns: [{ calls: [EDIT] }, { calls: [TESTS] }, { text: "C'est corrigé !" }, { text: "Vraiment corrigé." }],
    });
    await h.start();
    expect(h.terminals()[0]).toMatchObject({ type: "mission.failed", reason: "acceptance_failed" });
    // The model was asked once to verify before the failure.
    expect(h.requests[3]?.messages.at(-1)).toMatchObject({ role: "user", content: expect.stringMatching(/acceptance criteria must be verified/) });
    expectInvariants(h);
  });

  it("never executes a denied call and tells the model why", async () => {
    const h = createHarness({
      files: { "src/cart.ts": CART },
      tasks: [{ title: "Relire", acceptance: { kind: "manual", detail: "" } }],
      decide: (request) => (request.tool === "edit_file" ? { decision: "deny", reason: "profile_forbids", ruleId: "profile:read_only", rememberable: false, explanation: "Règle de test." } : ALLOW),
      turns: [{ calls: [EDIT] }, { text: "Je ne peux pas modifier ce fichier." }],
    });
    await h.start();
    expect(h.files.get("src/cart.ts")).toBe(CART);
    expect(h.types()).not.toContain("tool.started");
    expect(h.events().find((event) => event.type === "tool.finished")).toMatchObject({ state: "denied" });
    expect(h.requests[1]?.messages.at(-1)).toMatchObject({ role: "tool", content: expect.stringMatching(/permission_denied/) });
    expect(h.checkpoints).toEqual([]);
    expect(h.terminals()[0]?.type).toBe("mission.succeeded");
    expectInvariants(h);
  });

  it.each([
    ["approved", true],
    ["denied", false],
  ] as const)("waits for an approval, then runs only if %s", async (status, runs) => {
    let release: () => void = () => undefined;
    const h = createHarness({
      files: { "src/cart.ts": CART },
      tasks: [{ title: "Modifier", acceptance: { kind: "manual", detail: "" } }],
      decide: (request) => (request.tool === "edit_file" ? { decision: "ask", reason: "profile_asks", ruleId: "profile:assisted", rememberable: true, explanation: "Règle de test." } : ALLOW),
      approvals: {
        async request(input, options) {
          const pending = approvalFor(input.request, input.decision, "pending");
          options.onPending(pending);
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          return { ...pending, status, decidedAt: Date.now() };
        },
      },
      turns: [{ calls: [EDIT] }, { text: "Fini." }],
    });
    const done = h.start();
    await until(() => h.types().includes("approval.requested"));
    expect(h.states.at(-1)).toBe("waiting_approval");
    expect(h.types()).not.toContain("tool.started");
    release();
    await done;
    expect(h.types()).toContain("approval.resolved");
    expect(h.files.get("src/cart.ts") !== CART).toBe(runs);
    expect(h.events().find((event) => event.type === "tool.finished")).toMatchObject({ state: runs ? "succeeded" : "denied" });
    expectInvariants(h);
  });

  it("suspends at the budget cap and retries the same call after resume", async () => {
    const h = createHarness({
      tasks: [{ title: "Répondre", acceptance: { kind: "manual", detail: "" } }],
      turns: [{ error: new ProxyError("budget", "budget de la mission atteint (reste 0,00 $)") }, { text: "Voilà." }],
    });
    const done = h.start();
    await until(() => h.types().includes("mission.suspended"));
    expect(h.events().find((event) => event.type === "mission.suspended")).toMatchObject({ reason: "budget", detail: expect.stringContaining("budget") });
    h.loop.resume(h.missionId);
    await done;
    expect(h.types().slice(-3)).toEqual(["mission.resumed", "message.completed", "mission.succeeded"]);
    expectInvariants(h);
  });

  it("does not count time spent paused toward the duration cap", async () => {
    let clock = 0;
    const h = createHarness({
      tasks: [{ title: "Répondre", acceptance: { kind: "manual", detail: "" } }],
      files: { "src/cart.ts": CART },
      turns: [{ calls: [READ] }, { text: "Voilà." }],
      maxDurationMs: 30 * 60_000,
      now: () => clock,
    });
    const done = h.start();
    h.loop.pause(h.missionId);
    await until(() => h.types().includes("mission.suspended"));
    // Paused at once, resumed 40 minutes later: no work time, far from the 30 min cap.
    clock = 40 * 60_000;
    h.loop.resume(h.missionId);
    await done;
    expect(h.events().filter((event) => event.type === "mission.suspended")).toMatchObject([{ reason: "user" }]);
    expect(h.types().at(-1)).toBe("mission.succeeded");
    expectInvariants(h);
  });

  it("suspends when the same call returns the same result three times", async () => {
    const h = createHarness({ files: { "src/cart.ts": CART }, turns: [{ calls: [READ] }, { calls: [READ] }, { calls: [READ] }, { calls: [READ] }] });
    const done = h.start();
    await until(() => h.types().includes("mission.suspended"));
    expect(h.events().find((event) => event.type === "mission.suspended")).toMatchObject({ reason: "no_progress" });
    expect(h.requests).toHaveLength(3);
    h.loop.stop(h.missionId);
    await done;
    expect(h.terminals()).toMatchObject([{ type: "mission.cancelled", by: "user" }]);
    expectInvariants(h);
  });

  it("in Understand mode, never offers nor executes a write", async () => {
    const h = createHarness({
      mode: "understand",
      files: { "src/cart.ts": CART },
      tasks: [{ title: "Expliquer", acceptance: { kind: "test_passes", detail: "" } }],
      turns: [{ calls: [EDIT] }, { text: "Voici l'explication." }],
    });
    await h.start();
    expect(h.requests[0]?.tools.map((tool) => tool.name)).not.toContain("edit_file");
    expect(h.files.get("src/cart.ts")).toBe(CART);
    expect(h.evaluated.filter((request) => request.tool === "edit_file")).toEqual([]);
    expect(h.events().find((event) => event.type === "tool.permission")).toMatchObject({ decision: { decision: "deny", reason: "mode_forbids" } });
    expect(h.events().find((event) => event.type === "tool.finished")).toMatchObject({ state: "denied" });
    // test_passes cannot be checked without run tools: left to the user, so the mission succeeds.
    expect(h.terminals()[0]?.type).toBe("mission.succeeded");
    expectInvariants(h);
  });

  it("returns malformed arguments to the model without executing anything", async () => {
    const h = createHarness({
      files: { "src/cart.ts": CART },
      tasks: [{ title: "Lire", acceptance: { kind: "manual", detail: "" } }],
      turns: [{ calls: [{ name: "edit_file", arguments: '{"path": "src/cart.ts", "edits": "oops"' }] }, { calls: [{ name: "no_such_tool", arguments: "{}" }] }, { text: "ok" }],
    });
    await h.start();
    expect(h.files.get("src/cart.ts")).toBe(CART);
    expect(h.evaluated).toEqual([]);
    expect(h.events().find((event) => event.type === "tool.finished")).toMatchObject({ state: "failed", display: { kind: "error", code: "invalid_arguments" } });
    expect(h.requests[1]?.messages.at(-1)).toMatchObject({ role: "tool", content: expect.stringMatching(/invalid arguments/) });
    expect(h.requests[2]?.messages.at(-1)).toMatchObject({ role: "tool", content: expect.stringMatching(/unknown tool/) });
    expectInvariants(h);
  });

  it("stop during a running command kills it and ends with exactly one terminal event", async () => {
    let aborted = false;
    const hanging: CommandRunner = {
      ...fakeTestRunner(),
      run(_spec, signal): Promise<CommandOutcome> {
        return new Promise((resolve) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            resolve({ exitCode: null, signal: "SIGTERM", durationMs: 1, output: "", outputBytes: 0, truncated: false, timedOut: false, cancelled: true, isolationLevel: "L0" });
          });
        });
      },
    };
    const h = createHarness({ commands: hanging, turns: [{ calls: [{ name: "run_command", arguments: '{"argv":["pnpm","dev"]}' }] }] });
    const done = h.start();
    await until(() => h.types().includes("tool.started"));
    h.loop.stop(h.missionId);
    h.loop.stop(h.missionId);
    await done;
    expect(aborted).toBe(true);
    expect(h.events().find((event) => event.type === "tool.finished")).toMatchObject({ state: "cancelled" });
    expect(h.terminals()).toMatchObject([{ type: "mission.cancelled" }]);
    // The journal refuses a late second terminal.
    expect(h.journal.append({ type: "mission.failed", missionId: h.missionId, reason: "internal", detail: null })).toBeNull();
    expectInvariants(h);
  });

  it("fails with iteration_limit instead of looping forever", async () => {
    const h = createHarness({ files: { "src/cart.ts": CART }, turns: Array.from({ length: 50 }, (_, i) => ({ calls: [{ name: "read_file", arguments: `{"path":"src/cart.ts","startLine":${i + 1}}` }] })) });
    await h.start();
    expect(h.terminals()).toMatchObject([{ type: "mission.failed", reason: "iteration_limit" }]);
    expect(h.requests).toHaveLength(40);
  });
});
