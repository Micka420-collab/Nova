import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { HostParamsError, MCP_HOST_EVENTS, McpStdioHost, parseCallParams, parseConnectParams, type HostConnectParams } from "./host";
import type { McpRawTool, McpSessionInfo } from "./session";

const FIXTURE = fileURLToPath(new URL("./fixtures/test-server.ts", import.meta.url));
const SECRET = "fixture-secret-value-42";

let current: McpStdioHost | null = null;
afterEach(async () => {
  await current?.closeAll();
  current = null;
});

function setup(): { host: McpStdioHost; events: { method: string; params: unknown }[] } {
  const events: { method: string; params: unknown }[] = [];
  current = new McpStdioHost((method, payload) => events.push({ method, params: payload }));
  return { host: current, events };
}

function connectParams(overrides: Partial<HostConnectParams> = {}): HostConnectParams {
  return {
    serverId: "srv-1",
    launch: { command: process.execPath, args: [FIXTURE], env: { FIXTURE_TOKEN: SECRET }, cwd: null },
    secretEnvNames: ["FIXTURE_TOKEN"],
    connectTimeoutMs: 15_000,
    callTimeoutMs: null,
    ...overrides,
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("McpStdioHost against a real stdio server", () => {
  it("connects, negotiates, lists sorted tools, injects secrets only into the child and redacts stderr", async () => {
    const { host } = setup();
    process.env["NOVA_MCP_LEAK_CANARY"] = "leak";
    try {
      const result = await host.connect(connectParams());
      expect(result.info).toMatchObject({ state: "connected", protocolVersion: "2025-11-25", toolCount: 7 });
      expect(result.info.serverInfo).toBe("nova-fixture 1.0.0");
      expect(result.info.connectLatencyMs).toBeGreaterThanOrEqual(0);
      expect(result.tools.map((tool) => tool.name)).toEqual(["big", "crash", "echo", "env", "grow", "injected", "slow"]);
      expect(result.tools.find((tool) => tool.name === "echo")?.annotations).toEqual({ readOnlyHint: true });

      const injected = await host.callTool({ serverId: "srv-1", callId: "c1", name: "env", args: { name: "FIXTURE_TOKEN" }, timeoutMs: null });
      expect(injected).toMatchObject({ ok: true, text: "set" });
      const leaked = await host.callTool({ serverId: "srv-1", callId: "c2", name: "env", args: { name: "NOVA_MCP_LEAK_CANARY" }, timeoutMs: null });
      expect(leaked).toMatchObject({ ok: true, text: "unset" });

      await waitFor(() => host.stderr("srv-1").includes("fixture starting"));
      const stderr = host.stderr("srv-1");
      expect(stderr).not.toContain(SECRET);
      expect(stderr).toContain("token=[secret masqué]");
    } finally {
      delete process.env["NOVA_MCP_LEAK_CANARY"];
    }
  });

  it("calls a tool, caps large outputs and refuses unknown tools", async () => {
    const { host } = setup();
    await host.connect(connectParams());
    expect(await host.callTool({ serverId: "srv-1", callId: "c", name: "echo", args: { text: "salut" }, timeoutMs: null })).toMatchObject({
      ok: true,
      isError: false,
      text: "salut",
      truncated: false,
    });
    const big = await host.callTool({ serverId: "srv-1", callId: "b", name: "big", args: {}, timeoutMs: null });
    expect(big.ok && big.truncated && big.text.length < 60_000).toBe(true);
    expect(await host.callTool({ serverId: "srv-1", callId: "u", name: "nope", args: {}, timeoutMs: null })).toMatchObject({
      ok: false,
      code: "not_found",
    });
  });

  it("surfaces a server killed mid-call as an error, never a hang", async () => {
    const { host, events } = setup();
    await host.connect(connectParams());
    const outcome = await host.callTool({ serverId: "srv-1", callId: "k", name: "crash", args: {}, timeoutMs: 20_000 });
    expect(outcome).toMatchObject({ ok: false, code: "unavailable" });
    const infos = events.filter((event) => event.method === MCP_HOST_EVENTS.info).map((event) => event.params as McpSessionInfo);
    expect(infos.at(-1)).toMatchObject({ state: "error", lastError: "Le serveur s'est arrêté." });
    expect(host.sessionInfos()[0]?.state).toBe("error");
    expect(await host.callTool({ serverId: "srv-1", callId: "k2", name: "echo", args: { text: "x" }, timeoutMs: null })).toMatchObject({
      ok: false,
      code: "unavailable",
    });
  });

  it("times out a slow call without killing the server, and cancels on request", async () => {
    const { host } = setup();
    await host.connect(connectParams());
    const slow = await host.callTool({ serverId: "srv-1", callId: "s", name: "slow", args: { ms: 3_000 }, timeoutMs: 200 });
    expect(slow).toMatchObject({ ok: false, code: "timeout" });

    const pending = host.callTool({ serverId: "srv-1", callId: "s2", name: "slow", args: { ms: 3_000 }, timeoutMs: null });
    setTimeout(() => host.cancel("s2"), 100);
    expect(await pending).toMatchObject({ ok: false, code: "cancelled" });

    expect(await host.callTool({ serverId: "srv-1", callId: "e", name: "echo", args: { text: "ok" }, timeoutMs: null })).toMatchObject({
      ok: true,
      text: "ok",
    });
  });

  it("refreshes the tool list on notifications/tools/list_changed", async () => {
    const { host, events } = setup();
    await host.connect(connectParams());
    await host.callTool({ serverId: "srv-1", callId: "g", name: "grow", args: {}, timeoutMs: null });
    await waitFor(() => events.some((event) => event.method === MCP_HOST_EVENTS.tools));
    const update = events.find((event) => event.method === MCP_HOST_EVENTS.tools)?.params as { tools: McpRawTool[] };
    expect(update.tools.map((tool) => tool.name)).toContain("grown");
    expect(await host.listTools("srv-1", false)).toHaveLength(8);
  });

  it("reports a missing command and a server that never answers", async () => {
    const { host } = setup();
    const missing = await host.connect(
      connectParams({ launch: { command: "nova-no-such-command-xyz", args: [], env: {}, cwd: null } }),
    );
    expect(missing.info).toMatchObject({ state: "error", lastError: "Commande introuvable." });

    const silent = await host.connect(
      connectParams({
        serverId: "srv-2",
        launch: {
          command: process.execPath,
          args: ["-e", "process.stderr.write('booting\\n'); setInterval(() => {}, 1000)"],
          env: {},
          cwd: null,
        },
        connectTimeoutMs: 300,
      }),
    );
    expect(silent.info).toMatchObject({ state: "timeout", protocolVersion: null });
    expect(host.stderr("srv-2")).toContain("booting");
  });
});

describe("host params guards", () => {
  it("rejects malformed messages from main", () => {
    expect(() => parseConnectParams({ serverId: "a", launch: { command: "x", args: [1], env: {}, cwd: null }, secretEnvNames: [] })).toThrow(HostParamsError);
    expect(() => parseConnectParams({ serverId: "a", launch: { command: "x", args: [], env: { A: 1 }, cwd: null }, secretEnvNames: [] })).toThrow(HostParamsError);
    expect(parseConnectParams({ serverId: "a", launch: { command: "x", args: ["y"], env: { A: "b" }, cwd: null }, secretEnvNames: ["A"] })).toMatchObject({
      serverId: "a",
      connectTimeoutMs: null,
    });
    expect(() => parseCallParams({ serverId: "a", callId: "c", name: "t", args: [] })).toThrow(HostParamsError);
    expect(() => parseCallParams({ serverId: "a", callId: "c", name: "t", args: {}, timeoutMs: -1 })).toThrow(HostParamsError);
  });
});
