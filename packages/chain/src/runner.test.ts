// Main-side runner over a scripted host: relaying to the gateway, limits enforced again in main,
// host failures, stop, and bounded/redacted output. The real host is covered in apps/desktop.
import type { ToolResult } from "@nova/shared";
import type { ChainApi } from "@nova/tools";
import { describe, expect, it } from "vitest";
import type { ChainHostRequest } from "./protocol";
import { createChainRunner, type ChainHostConnection, type ChainHostExit, type ChainNestedRunContext } from "./runner";

const SECRET = "sk-or-v1-0123456789abcdef0123456789abcdef";

/** A host whose behavior the test scripts: `onRun` reacts to the run request, `onResult` to results. */
function fakeHost(script: {
  onRun?: (host: FakeHost, request: Extract<ChainHostRequest, { type: "run" }>) => void;
  onResult?: (host: FakeHost, request: Extract<ChainHostRequest, { type: "tool.result" }>) => void;
}) {
  const hosts: FakeHost[] = [];
  const open = (): ChainHostConnection => {
    const host = new FakeHost(script);
    hosts.push(host);
    return host;
  };
  return { open, hosts };
}

class FakeHost implements ChainHostConnection {
  readonly sent: ChainHostRequest[] = [];
  killed = false;
  runId = "";
  private messageListener: ((message: unknown) => void) | null = null;
  private exitListener: ((exit: ChainHostExit) => void) | null = null;

  constructor(
    private readonly script: {
      onRun?: (host: FakeHost, request: Extract<ChainHostRequest, { type: "run" }>) => void;
      onResult?: (host: FakeHost, request: Extract<ChainHostRequest, { type: "tool.result" }>) => void;
    },
  ) {}

  send(request: ChainHostRequest): void {
    this.sent.push(request);
    queueMicrotask(() => {
      if (request.type === "run") {
        this.runId = request.runId;
        this.script.onRun?.(this, request);
      } else this.script.onResult?.(this, request);
    });
  }
  onMessage(listener: (message: unknown) => void): void {
    this.messageListener = listener;
  }
  onExit(listener: (exit: ChainHostExit) => void): void {
    this.exitListener = listener;
  }
  kill(): void {
    this.killed = true;
  }
  emit(message: Record<string, unknown>): void {
    this.messageListener?.({ runId: this.runId, ...message });
  }
  exit(code: number | null, outOfMemory = false): void {
    this.exitListener?.({ code, outOfMemory });
  }
}

function ok(content: string): ToolResult {
  return { callId: "x", ok: true, content, display: { kind: "error", code: "failed", message: "" }, provenance: { source: "nova", untrusted: false, ref: null }, durationMs: 0 };
}

function context(runNested: ChainNestedRunContext["runNested"], signal = new AbortController().signal): ChainNestedRunContext {
  return { workspaceId: "w", missionId: "m", callId: "parent", signal, runNested };
}

describe("ChainRunner", () => {
  it("is the ChainApi that ToolDeps.chain takes", () => {
    const api: ChainApi = createChainRunner({ openHost: () => new FakeHost({}) });
    expect(typeof api.run).toBe("function");
  });

  it("relays each program call to runNested with the exact arguments and answers the host", async () => {
    const { open, hosts } = fakeHost({
      onRun: (host) => host.emit({ type: "tool.call", requestId: "c1", tool: "read_file", argsJson: '{"path":"a.ts"}' }),
      onResult: (host, request) => host.emit({ type: "done", state: "succeeded", result: JSON.stringify(request.content), error: null }),
    });
    const calls: { name: string; rawArguments: string }[] = [];
    const outcome = await createChainRunner({ openHost: open }).run("return 1;", context(async (call) => (calls.push(call), ok("a content"))));
    expect(calls).toEqual([{ name: "read_file", rawArguments: '{"path":"a.ts"}' }]);
    expect(hosts[0]!.sent[1]).toMatchObject({ type: "tool.result", requestId: "c1", ok: true, content: "a content" });
    expect(outcome).toMatchObject({ summary: { callId: "parent", state: "succeeded", toolCalls: 1, error: null }, result: '"a content"' });
    expect(hosts[0]!.killed).toBe(true);
  });

  it("passes a refusal to the program as a failed result, never as an effect", async () => {
    const refused: ToolResult = { ...ok("Error (permission_denied): refused"), ok: false };
    const { open, hosts } = fakeHost({
      onRun: (host) => host.emit({ type: "tool.call", requestId: "c1", tool: "delete_path", argsJson: '{"path":"a"}' }),
      onResult: (host) => host.emit({ type: "done", state: "failed", result: null, error: "Error: Error (permission_denied): refused" }),
    });
    const outcome = await createChainRunner({ openHost: open }).run("x();", context(async () => refused));
    expect(hosts[0]!.sent[1]).toMatchObject({ type: "tool.result", ok: false, content: "Error (permission_denied): refused" });
    expect(outcome.summary).toMatchObject({ state: "failed", toolCalls: 1 });
  });

  it("enforces the call limit in main even when the host does not", async () => {
    const { open } = fakeHost({
      onRun: (host) => {
        for (let index = 0; index < 5; index += 1) host.emit({ type: "tool.call", requestId: `c${index}`, tool: "read_file", argsJson: "{}" });
      },
    });
    let relayed = 0;
    const outcome = await createChainRunner({ openHost: open, limits: { maxToolCalls: 2 } }).run(
      "x();",
      context(async () => (relayed += 1, ok("x"))),
    );
    // The whole burst arrived before any call started: nothing runs once the limit ended the program.
    expect(relayed).toBe(0);
    expect(outcome.summary).toMatchObject({ state: "limit", toolCalls: 0, error: "the program made more than 2 tool calls" });
  });

  it("stops a host that never ends at the wall-time limit and kills it", async () => {
    const { open, hosts } = fakeHost({});
    const outcome = await createChainRunner({ openHost: open, limits: { timeoutMs: 30 } }).run("x();", context(async () => ok("x")));
    expect(outcome.summary).toMatchObject({ state: "timeout", error: expect.stringContaining("ran longer than") });
    expect(hosts[0]!.killed).toBe(true);
  });

  it("reports a host that dies as a failure", async () => {
    const { open } = fakeHost({ onRun: (host) => host.exit(134) });
    const outcome = await createChainRunner({ openHost: open }).run("x();", context(async () => ok("x")));
    expect(outcome.summary).toMatchObject({ state: "failed", error: "the program host stopped unexpectedly (code 134)" });
  });

  it("reports a host killed by its heap cap as a memory limit", async () => {
    const { open } = fakeHost({ onRun: (host) => host.exit(133, true) });
    const outcome = await createChainRunner({ openHost: open, limits: { heapMb: 64 } }).run("x();", context(async () => ok("x")));
    expect(outcome.summary).toMatchObject({ state: "limit", error: "the program used more than 64 MB of memory" });
  });

  it("fails on an invalid host message", async () => {
    const { open } = fakeHost({ onRun: (host) => host.emit({ type: "tool.call", requestId: 3 }) });
    const outcome = await createChainRunner({ openHost: open }).run("x();", context(async () => ok("x")));
    expect(outcome.summary).toMatchObject({ state: "failed", error: "the program host sent an invalid message" });
  });

  it("stops on the mission signal, after the call in flight settles", async () => {
    const controller = new AbortController();
    const order: string[] = [];
    const { open, hosts } = fakeHost({
      onRun: (host) => host.emit({ type: "tool.call", requestId: "c1", tool: "run_tests", argsJson: "{}" }),
    });
    const outcome = await createChainRunner({ openHost: open }).run(
      "x();",
      context(async () => {
        controller.abort();
        await new Promise((resolve) => setTimeout(resolve, 20));
        order.push("child settled");
        return ok("cancelled");
      }, controller.signal),
    );
    order.push("parent returned");
    expect(order).toEqual(["child settled", "parent returned"]);
    expect(outcome.summary.state).toBe("cancelled");
    expect(hosts[0]!.killed).toBe(true);
    // Nothing is sent to a host that is being killed.
    expect(hosts[0]!.sent.map((request) => request.type)).toEqual(["run"]);
  });

  it("refuses a program that does not pass the checks without starting a host", async () => {
    const { open, hosts } = fakeHost({});
    const outcome = await createChainRunner({ openHost: open }).run("await import('node:fs');", context(async () => ok("x")));
    expect(outcome.summary).toMatchObject({ state: "failed", error: expect.stringMatching(/^forbidden_syntax/) });
    expect(hosts).toHaveLength(0);
  });

  it("bounds and redacts the result, the logs and the error", async () => {
    const { open } = fakeHost({
      onRun: (host) => {
        host.emit({ type: "log", text: `token ${SECRET}` });
        for (let index = 0; index < 50; index += 1) host.emit({ type: "log", text: "y".repeat(100) });
        host.emit({ type: "done", state: "succeeded", result: JSON.stringify(`${SECRET}${"z".repeat(5_000)}`), error: null });
      },
    });
    const outcome = await createChainRunner({ openHost: open, limits: { resultMaxChars: 1_000, logMaxChars: 500 } }).run(
      "x();",
      context(async () => ok("x")),
    );
    expect(outcome.result).not.toContain(SECRET);
    expect(outcome.result!.length).toBeLessThanOrEqual(1_000);
    expect(outcome.logs).not.toContain(SECRET);
    expect(outcome.logs.length).toBeLessThanOrEqual(500 + 40);
    expect(outcome.logs).toContain("further output omitted");
  });

  it("does not start when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const { open, hosts } = fakeHost({});
    const outcome = await createChainRunner({ openHost: open }).run("return 1;", context(async () => ok("x"), controller.signal));
    expect(outcome.summary.state).toBe("cancelled");
    expect(hosts).toHaveLength(0);
  });

  it("fails visibly when the host cannot start", async () => {
    const outcome = await createChainRunner({
      openHost: () => {
        throw new Error("spawn failed");
      },
    }).run("return 1;", context(async () => ok("x")));
    expect(outcome.summary).toMatchObject({ state: "failed", error: "the program host could not start" });
  });
});
