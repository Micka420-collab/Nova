// J2-B extension points of the mission loop and of the tool set: absent hooks keep J2-A
// behavior; present hooks are the only way compaction and continuation change a mission.
import { describe, expect, it } from "vitest";
import type { ProxyMessage } from "./index";
import { createHarness, fakeTestRunner } from "./__fixtures__/harness";
import type { LoopContinuationHook } from "./loop";
import { missionToolSet } from "./tool-set";

const CART = "export function total(items: number[]) {\n  return items.length;\n}\n";
const TESTS = { name: "run_tests", arguments: '{"filter":["cart"]}' };

describe("mission tool set: contract opt-ins", () => {
  it("never offers run_chain or start_submission from the mode alone", () => {
    const plain = missionToolSet("build", { webSearch: false, mcpTools: [] });
    expect(plain.has("run_chain")).toBe(false);
    expect(plain.has("start_submission")).toBe(false);
    expect(plain.has("process_list")).toBe(true);
    expect(plain.has("skill")).toBe(true);
  });

  it("adds them when the contract opts in, but never in discuss", () => {
    const harness = { chain: true, autoContinue: null, subMissions: { maxChildren: 2 } };
    const build = missionToolSet("build", { webSearch: false, mcpTools: [], harness });
    expect(build.has("run_chain")).toBe(true);
    expect(build.has("start_submission")).toBe(true);
    const discuss = missionToolSet("discuss", { webSearch: true, mcpTools: [], harness });
    expect(discuss.has("run_chain")).toBe(false);
    expect(discuss.has("start_submission")).toBe(false);
    expect(missionToolSet("verify", { webSearch: false, mcpTools: [], harness }).has("process_stop")).toBe(false);
  });
});

describe("mission loop hooks", () => {
  it("starts a new round when the continuation hook asks, and succeeds once proven", async () => {
    const commands = fakeTestRunner({ failing: true });
    const rounds: number[] = [];
    const continuation: LoopContinuationHook = {
      nextRound: async ({ round, open }) => {
        rounds.push(round);
        expect(open.map((criterion) => criterion.title)).toEqual(["Tests verts"]);
        return { prompt: `Round ${round}: make the tests pass.` };
      },
    };
    let failing = true;
    const runner = {
      ...commands,
      run: async (...args: Parameters<typeof commands.run>) => {
        const outcome = await (failing ? commands : fakeTestRunner()).run(...args);
        failing = false;
        return outcome;
      },
    };
    const h = createHarness({
      files: { "src/cart.ts": CART },
      commands: runner,
      extensions: { continuation },
      // Round 0: failing tests, a claim, the nudge, a second claim → hook → round 1 proves it.
      turns: [{ calls: [TESTS] }, { text: "Fini." }, { text: "Toujours fini." }, { calls: [TESTS] }, { text: "Tests verts." }],
    });
    await h.start();
    expect(rounds).toEqual([1]);
    expect(h.terminals()[0]).toMatchObject({ type: "mission.succeeded" });
    expect(h.requests[3]?.messages.at(-1)).toMatchObject({ role: "user", content: "Round 1: make the tests pass." });
  });

  it("ends with acceptance_failed when the continuation hook declines", async () => {
    const h = createHarness({
      files: { "src/cart.ts": CART },
      commands: fakeTestRunner({ failing: true }),
      extensions: { continuation: { nextRound: async () => null } },
      turns: [{ calls: [TESTS] }, { text: "Fini." }, { text: "Toujours fini." }],
    });
    await h.start();
    expect(h.terminals()[0]).toMatchObject({ type: "mission.failed", reason: "acceptance_failed" });
  });

  it("sends what the context hook prepared and reports each call's usage", async () => {
    const observed: (number | null)[] = [];
    const h = createHarness({
      files: { "src/cart.ts": CART },
      tasks: [{ title: "Lire", acceptance: { kind: "manual", detail: "" } }],
      extensions: {
        context: {
          prepare: async ({ messages }) =>
            messages.length > 2
              ? {
                  messages: [messages[0] as ProxyMessage, { role: "user", content: "Summary of the work so far (applied by the user)." }],
                  modelId: "acme/next",
                }
              : null,
          observe: ({ usage }) => observed.push(usage?.promptTokens ?? null),
        },
      },
      turns: [{ calls: [{ name: "read_file", arguments: '{"path":"src/cart.ts"}' }] }, { text: "Lu." }],
    });
    await h.start();
    expect(h.requests[1]?.messages.map((message) => message.role)).toEqual(["system", "user"]);
    // A15: after a handoff the next calls use the model the user chose.
    expect(h.requests.map((request) => request.modelId)).toEqual(["acme/model", "acme/next"]);
    expect(observed).toHaveLength(2);
    expect(h.terminals()[0]).toMatchObject({ type: "mission.succeeded" });
  });
});
