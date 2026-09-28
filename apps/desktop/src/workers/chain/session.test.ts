// The chain-host session with its REAL sandbox (fresh V8 context, timed slices): what a program can
// reach, how each limit ends it, and how tool results and refusals travel.
import type { ChainHostMessage, ChainLimits } from "@nova/chain";
import { describe, expect, it } from "vitest";
import { createChainHostSession } from "./session";

const RUN = "run-1";

type Done = Extract<ChainHostMessage, { type: "done" }>;
type Call = Extract<ChainHostMessage, { type: "tool.call" }>;

/** A session driven like main drives it; `answer` settles each tool call (default: echo). */
function host(options: { limits?: Partial<ChainLimits>; heap?: () => number; answer?: (call: Call) => { ok: boolean; content: string } | null } = {}) {
  const messages: ChainHostMessage[] = [];
  const session = createChainHostSession({
    post: (message) => {
      messages.push(message);
      if (message.type !== "tool.call") return;
      const reply = (options.answer ?? ((call) => ({ ok: true, content: `result of ${call.tool} ${call.argsJson}` })))(message);
      // Asynchronous like the real parent port: never re-entered from inside a slice.
      if (reply) setImmediate(() => session.handle({ type: "tool.result", runId: RUN, requestId: message.requestId, ...reply }));
    },
    heapUsedBytes: options.heap ?? (() => 0),
    limits: { syncSliceMs: 200, ...options.limits },
  });
  const done = async (program: string): Promise<{ done: Done; messages: ChainHostMessage[] }> => {
    session.handle({ type: "run", runId: RUN, program });
    for (let waited = 0; waited < 5_000; waited += 5) {
      const found = messages.find((message): message is Done => message.type === "done");
      if (found) return { done: found, messages };
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("the program never ended");
  };
  return { done, messages, session };
}

describe("chain-host session: what a program can reach", () => {
  it.each([
    ["require", "return require('node:fs');", "ReferenceError: require is not defined"],
    ["process", "return process.env;", "ReferenceError: process is not defined"],
    ["fetch", "return await fetch('https://example.com');", "ReferenceError: fetch is not defined"],
    ["timers", "setTimeout(() => {}, 1);", "ReferenceError: setTimeout is not defined"],
  ])("has no %s", async (_what, program, error) => {
    const { done } = await host().done(program);
    expect(done).toMatchObject({ state: "failed", result: null, error });
  });

  it("has no console of the host (only the one it is given)", async () => {
    const { done } = await host().done("return typeof globalThis.console;");
    expect(done).toMatchObject({ state: "succeeded", result: '"undefined"' });
  });

  it("refuses import() before running anything", async () => {
    const { done, messages } = await host().done("const fs = await import('node:fs');\nreturn fs;");
    expect(done).toMatchObject({ state: "failed", error: expect.stringMatching(/^forbidden_syntax: import\(\)/) });
    expect(messages.filter((message) => message.type === "tool.call")).toHaveLength(0);
  });

  it("cannot generate code, even through the constructors of what it is given", async () => {
    const attempts = [
      "return eval('1 + 1');",
      "return new Function('return 1')();",
      "return nova.read_file.constructor.constructor('return process')();",
      "return (await nova.read_file({ path: 'a' })).constructor.constructor('return process')();",
      "try { await nova.denied({}); } catch (error) { return error.constructor.constructor('return process')(); }",
      "return console.log.constructor.constructor('return process')();",
      "return globalThis.constructor.constructor('return process')();",
    ];
    const outcomes: [string, string, string | null][] = [];
    for (const program of attempts) {
      const { done } = await host({ answer: (call) => ({ ok: call.tool !== "denied", content: "x" }) }).done(program);
      outcomes.push([program, done.state, done.error]);
    }
    expect(outcomes).toEqual(attempts.map((program) => [program, "failed", "EvalError: Code generation from strings disallowed for this context"]));
  });

  it("gets no blocking wait nor raw WebAssembly", async () => {
    const { done } = await host().done("return [typeof Atomics, typeof SharedArrayBuffer, typeof WebAssembly];");
    expect(done).toMatchObject({ state: "succeeded", result: '["undefined","undefined","undefined"]' });
  });
});

describe("chain-host session: limits", () => {
  it("stops a synchronous infinite loop", async () => {
    const { done } = await host().done("while (true) {}");
    expect(done).toMatchObject({ state: "timeout", error: expect.stringContaining("without waiting for a tool") });
  });

  it("stops an infinite loop that starts after a tool result", async () => {
    const { done, messages } = await host().done("await nova.read_file({ path: 'a.ts' });\nfor (;;) {}");
    expect(messages.filter((message) => message.type === "tool.call")).toHaveLength(1);
    expect(done.state).toBe("timeout");
  });

  it("stops a loop of promise jobs that never gives control back", async () => {
    const { done } = await host().done("while (true) await null;");
    expect(done.state).toBe("timeout");
  });

  it("stops a program whose heap is past the cap after a slice", async () => {
    // The host charges the program with its process heap (chain-host.ts); here the measure jumps
    // once the program has allocated, as `process.memoryUsage()` would in the real host.
    const measure = { bytes: 0 };
    const { done, messages } = await host({
      limits: { heapMb: 16 },
      heap: () => measure.bytes,
      answer: () => ((measure.bytes = 40 * 1024 * 1024), { ok: true, content: "x" }),
    }).done("const keep = [];\nfor (let i = 0; i < 3; i += 1) { keep.push(new Array(1e5).fill(i)); await nova.read_file({ path: 'a.ts' }); }\nreturn keep.length;");
    expect(messages.filter((message) => message.type === "tool.call")).toHaveLength(1);
    expect(done).toMatchObject({ state: "limit", error: "the program used more than 16 MB of memory" });
  });

  it("stops at the tool-call limit without relaying the extra call", async () => {
    const { done, messages } = await host({ limits: { maxToolCalls: 3 } }).done(
      "for (let i = 0; i < 10; i += 1) await nova.read_file({ path: `f${i}.ts` });",
    );
    expect(messages.filter((message) => message.type === "tool.call")).toHaveLength(3);
    expect(done).toMatchObject({ state: "limit", error: "the program made more than 3 tool calls" });
  });

  it("refuses a return value larger than the result cap", async () => {
    const { done } = await host({ limits: { resultMaxChars: 100 } }).done("return 'y'.repeat(500);");
    expect(done).toMatchObject({ state: "limit", result: null, error: expect.stringContaining("the limit is 100") });
  });
});

describe("chain-host session: tool calls", () => {
  it("relays calls with their JSON arguments and returns the program's value", async () => {
    const { done, messages } = await host().done(
      "const a = await nova.read_file({ path: 'a.ts' });\nconst b = await nova.read_file({ path: 'b.ts' });\nconsole.log('read', 2, { ok: true });\nreturn { a, b };",
    );
    const calls = messages.filter((message): message is Call => message.type === "tool.call");
    expect(calls.map((call) => [call.tool, call.argsJson])).toEqual([
      ["read_file", '{"path":"a.ts"}'],
      ["read_file", '{"path":"b.ts"}'],
    ]);
    expect(messages).toContainEqual({ type: "log", runId: RUN, text: 'read 2 {"ok":true}' });
    expect(done).toEqual({
      type: "done",
      runId: RUN,
      state: "succeeded",
      result: JSON.stringify({ a: 'result of read_file {"path":"a.ts"}', b: 'result of read_file {"path":"b.ts"}' }),
      error: null,
    });
  });

  it("turns a refused call into an Error the program can catch", async () => {
    const { done } = await host({
      answer: (call) => (call.tool === "write_file" ? { ok: false, content: "Error (permission_denied): the user refused this action" } : { ok: true, content: "ok" }),
    }).done("try {\n  await nova.write_file({ path: 'a.ts', content: 'x' });\n  return 'written';\n} catch (error) {\n  return error.message;\n}");
    expect(done).toMatchObject({ state: "succeeded", result: '"Error (permission_denied): the user refused this action"' });
  });

  it("fails the program when a refusal is not caught", async () => {
    const { done } = await host({ answer: () => ({ ok: false, content: "Error (permission_denied): refused" }) }).done(
      "await nova.delete_path({ path: 'a.ts' });\nreturn 'unreachable';",
    );
    expect(done).toMatchObject({ state: "failed", error: "Error: Error (permission_denied): refused" });
  });

  it("waits while a call is pending (an approval) and resumes when it is answered", async () => {
    let settle: (() => void) | null = null;
    const pending = host({ answer: (call) => ((settle = () => pending.session.handle({ type: "tool.result", runId: RUN, requestId: call.requestId, ok: true, content: "approved" })), null) });
    const finished = pending.done("return await nova.write_file({ path: 'a.ts', content: 'x' });");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(pending.messages.some((message) => message.type === "done")).toBe(false);
    settle!();
    expect((await finished).done).toMatchObject({ state: "succeeded", result: '"approved"' });
  });

  it("ignores results for another run and late results", async () => {
    const { done, session, messages } = await (async () => {
      const h = host();
      const outcome = await h.done("return await nova.read_file({ path: 'a.ts' });");
      return { ...outcome, session: h.session };
    })();
    const count = messages.length;
    session.handle({ type: "tool.result", runId: "other", requestId: "c1", ok: true, content: "late" });
    session.handle({ type: "tool.result", runId: RUN, requestId: "c1", ok: true, content: "late" });
    session.handle({ type: "run", runId: "second", program: "return 1;" });
    expect(messages).toHaveLength(count);
    expect(done.state).toBe("succeeded");
  });

  it("refuses a program that does not parse, before running it", async () => {
    const { done } = await host().done("const a = 1;\nconst = 2;");
    expect(done).toMatchObject({ state: "failed", error: expect.stringMatching(/^syntax: syntax error/) });
  });
});
