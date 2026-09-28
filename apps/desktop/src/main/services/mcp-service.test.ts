import { fileURLToPath } from "node:url";
import { McpStdioHost, createHostHandlers } from "@nova/mcp";
import { createMcpRepo, createWorkspaceRepo, type NovaStore, openNovaStore } from "@nova/storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startHttpFixture, type HttpFixture } from "../../../../../packages/mcp/src/fixtures/http-server";
import type { SecretVault } from "../vault";
import { McpService, type McpHostPort } from "./mcp-service";

const FIXTURE = fileURLToPath(new URL("../../../../../packages/mcp/src/fixtures/test-server.ts", import.meta.url));
const SECRET = "fixture-secret-value-4242";

/** Reversible fake: ciphertext never equals the plaintext bytes. */
const vault: SecretVault = {
  status: async () => ({ level: "os", backend: "test" }),
  encrypt: async (plain) => new TextEncoder().encode(`enc:${[...plain].reverse().join("")}`),
  decrypt: async (cipher) => ({
    plain: [...new TextDecoder().decode(cipher).slice(4)].reverse().join(""),
    shouldReEncrypt: false,
  }),
};

/** McpHostPort over an in-process McpStdioHost: same handlers as the mcp-host worker. */
function inProcessHost(): McpHostPort & { host: McpStdioHost } {
  const listeners = new Set<(event: { method: string; params: unknown }) => void>();
  const host = new McpStdioHost((method, params) => {
    for (const listener of listeners) listener({ method, params });
  });
  const handlers = createHostHandlers(host);
  return {
    host,
    start: () => {},
    request: async <T,>(method: string, params?: unknown): Promise<T> => {
      const handler = handlers[method];
      if (!handler) throw new Error(`unknown ${method}`);
      return (await handler(params)) as T;
    },
    notify: (method, params) => {
      void handlers[method]?.(params);
    },
    onNotify: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

let store: NovaStore;
let hostPort: ReturnType<typeof inProcessHost>;
let service: McpService;
let workspaceId: string;
let fixture: HttpFixture | null = null;

beforeEach(() => {
  store = openNovaStore(":memory:");
  workspaceId = createWorkspaceRepo(store.db).upsertByRootPath({ rootPath: "/tmp", name: "tmp" }).id;
  hostPort = inProcessHost();
  service = new McpService({
    repo: createMcpRepo(store.db),
    secrets: store,
    vault,
    host: hostPort,
    workspaceRoot: (id) => (id === workspaceId ? "/tmp" : null),
    connectTimeoutMs: 15_000,
    callTimeoutMs: 20_000,
  });
});

afterEach(async () => {
  await service.shutdown();
  await hostPort.host.closeAll();
  await fixture?.close();
  fixture = null;
  store.close();
});

/** Calls the tool the model was offered under `name` (by its server id and tool name, as the registry does). */
async function call(name: string, args: Record<string, unknown>, approved = true) {
  const offered = (await service.listToolsForModel(workspaceId, { connect: false })).find((tool) => tool.definition.name === name);
  const target = offered ? { serverId: offered.serverId, toolName: offered.toolName } : { serverId: "unknown", toolName: name };
  return service.callTool(target, args, { workspaceId, callId: crypto.randomUUID(), signal: new AbortController().signal, approved });
}

async function addFixture(enabled = true) {
  return service.api().add({
    name: "Fixture",
    transport: {
      type: "stdio",
      command: process.execPath,
      args: [FIXTURE],
      env: { FIXTURE_TOKEN: { kind: "secret", value: SECRET }, MODE: { kind: "plain", value: "test" } },
    },
    scope: "global",
    workspaceId: null,
    enabled,
  });
}

describe("McpService (stdio through the host)", () => {
  it("stores secrets in the vault only, tests the server and flags injection-like descriptions", async () => {
    const added = await addFixture();
    expect(added.status.state).toBe("stopped");
    const env = added.config.transport.type === "stdio" ? added.config.transport.env : {};
    expect(env["FIXTURE_TOKEN"]).toMatchObject({ kind: "secret_ref", hint: "4242" });
    const row = store.db.prepare("SELECT config_json FROM mcp_servers").get() as { config_json: string };
    expect(row.config_json).not.toContain(SECRET);

    const tested = await service.api().test({ serverId: added.config.id });
    expect(tested.status).toMatchObject({ state: "connected", protocolVersion: "2025-11-25", toolCount: 7 });
    expect(tested.stderrTail).toContain("token=[secret masqué]");
    expect(tested.stderrTail).not.toContain(SECRET);
    const injected = tested.tools.find((tool) => tool.name === "injected");
    expect(injected).toMatchObject({ permission: "ask", qualifiedName: "mcp__Fixture__injected" });
    expect((injected as unknown as { descriptionFlags: string[] }).descriptionFlags).toContain("override_instructions");

    // The secret reached the child process (and only through its env).
    expect((await call("mcp__Fixture__env", { name: "FIXTURE_TOKEN" })).content).toContain("set");
    // …and the web guard knows it literally (W5: a URL carrying it is refused).
    expect(service.knownSecrets()).toContain(SECRET);
  });

  it("offers tools to the model sorted, defaults to ask, and enforces deny/ask/allow on calls", async () => {
    const { config } = await addFixture();
    const tools = await service.listToolsForModel(workspaceId);
    expect(tools.map((tool) => tool.definition.name)).toEqual([
      "mcp__Fixture__big",
      "mcp__Fixture__crash",
      "mcp__Fixture__echo",
      "mcp__Fixture__env",
      "mcp__Fixture__grow",
      "mcp__Fixture__injected",
      "mcp__Fixture__slow",
    ]);
    expect(tools.every((tool) => tool.permission === "ask")).toBe(true);
    expect(tools.find((tool) => tool.toolName === "echo")?.definition.operation).toBe("read");
    expect(tools.find((tool) => tool.toolName === "slow")?.definition.operation).toBe("external");

    // ask without approval: refused, never executed.
    const unapproved = await call("mcp__Fixture__echo", { text: "hi" }, false);
    expect(unapproved).toMatchObject({ ok: false, display: { kind: "error", code: "permission_denied" } });

    const approved = await call("mcp__Fixture__echo", { text: "hi" });
    expect(approved).toMatchObject({ ok: true, provenance: { source: "mcp", untrusted: true, ref: "Fixture/echo" } });
    expect(approved.content).toContain("hi");

    await service.api().setToolPermission({ serverId: config.id, toolName: "echo", workspaceId: null, permission: "allow" });
    expect((await call("mcp__Fixture__echo", { text: "direct" }, false)).ok).toBe(true);

    // deny (the disabled tool): not offered, and a call is refused before reaching the server.
    await service.api().setToolPermission({ serverId: config.id, toolName: "echo", workspaceId, permission: "deny" });
    expect((await service.listToolsForModel(workspaceId)).some((tool) => tool.toolName === "echo")).toBe(false);
    expect(await call("mcp__Fixture__echo", { text: "x" })).toMatchObject({ ok: false, display: { code: "not_found" } });
    // The global allow still applies elsewhere.
    expect((await service.api().tools({ serverId: config.id, workspaceId: null })).find((t) => t.name === "echo")?.permission).toBe(
      "allow",
    );
  });

  it("never offers nor runs tools of a disabled server", async () => {
    const { config } = await addFixture();
    await service.listToolsForModel(workspaceId);
    const updated = await service.api().update({ serverId: config.id, enabled: false });
    expect(updated.status.state).toBe("disabled");
    expect(await service.listToolsForModel(workspaceId)).toEqual([]);
    expect(await call("mcp__Fixture__echo", { text: "x" })).toMatchObject({ ok: false });
    expect(hostPort.host.sessionInfos()).toEqual([]);
  });

  it("runs a call on the server that was offered, never on a same-named server that connected later", async () => {
    // Workspace server without the token, connected first; the global one (with it) connects later
    // and may take the qualified name (ordered by server id).
    const local = await service.api().add({
      name: "Fixture",
      transport: { type: "stdio", command: process.execPath, args: [FIXTURE], env: {} },
      scope: "workspace",
      workspaceId,
      enabled: true,
    });
    const global = await addFixture(false);
    const offered = (await service.listToolsForModel(workspaceId)).find((tool) => tool.toolName === "env");
    expect(offered?.serverId).toBe(local.config.id);
    await service.api().update({ serverId: global.config.id, enabled: true });
    await service.listToolsForModel(workspaceId);
    expect((await service.api().list({ workspaceId })).map((view) => view.status.state)).toEqual(["connected", "connected"]);
    const result = await service.callTool({ serverId: local.config.id, toolName: "env" }, { name: "FIXTURE_TOKEN" }, {
      workspaceId,
      callId: crypto.randomUUID(),
      signal: new AbortController().signal,
      approved: true,
    });
    // Either the offered server answers ("unset") or the call is refused: the global server ("set") never runs it.
    expect(result.content).not.toMatch(/\bset\b/);
  });

  it("surfaces a server killed mid-call as a failed result and an error status", async () => {
    const { config } = await addFixture();
    await service.listToolsForModel(workspaceId);
    const result = await call("mcp__Fixture__crash", {});
    expect(result).toMatchObject({ ok: false, display: { kind: "error", code: "unavailable" } });
    const [view] = await service.api().list({ workspaceId: null });
    expect(view?.status).toMatchObject({ serverId: config.id, state: "error" });
    expect(await call("mcp__Fixture__echo", { text: "x" })).toMatchObject({ ok: false });
  });

  it("refuses references to secrets the server does not own, and deletes secrets with the server", async () => {
    const { config } = await addFixture();
    const foreign = crypto.randomUUID();
    store.putSecret({ id: foreign, ciphertext: new Uint8Array([1]), backend: "test", createdAt: 1 });
    await expect(
      service.api().update({
        serverId: config.id,
        transport: { type: "stdio", command: "npx", args: [], env: { STEAL: { kind: "secret_ref", secretRef: foreign } } },
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });

    const ref = config.transport.type === "stdio" ? config.transport.env["FIXTURE_TOKEN"] : undefined;
    const secretRef = ref?.kind === "secret_ref" ? ref.secretRef : "";
    // Keeping its own reference is fine.
    await service.api().update({
      serverId: config.id,
      transport: { type: "stdio", command: process.execPath, args: [FIXTURE], env: { FIXTURE_TOKEN: { kind: "secret_ref", secretRef } } },
    });
    expect(store.getSecret(secretRef)).not.toBeNull();

    await service.api().remove({ serverId: config.id });
    expect(store.getSecret(secretRef)).toBeNull();
    expect(store.getSecret(foreign)).not.toBeNull();
    await expect(addFixture()).resolves.toBeTruthy();
    await expect(addFixture()).rejects.toMatchObject({ code: "conflict" });
  });
});

describe("McpService (Streamable HTTP from main)", () => {
  it("connects with the vault-stored header, lists and calls tools", async () => {
    fixture = await startHttpFixture("Bearer http-secret-123456");
    const added = await service.api().add({
      name: "Remote",
      transport: {
        type: "http",
        url: fixture.url,
        headers: { Authorization: { kind: "secret", value: "Bearer http-secret-123456" } },
      },
      scope: "workspace",
      workspaceId,
      enabled: true,
    });
    const tested = await service.api().test({ serverId: added.config.id });
    expect(tested.status).toMatchObject({ state: "connected", protocolVersion: "2025-11-25", toolCount: 1 });
    const result = await call("mcp__Remote__ping", {});
    expect(result).toMatchObject({ ok: true, display: { kind: "mcp", text: "pong" } });
    expect(fixture.received.every((auth) => auth === "Bearer http-secret-123456")).toBe(true);
  });

  it("refuses to send a secret header over clear-text http to a non-loopback host", async () => {
    await expect(
      service.api().add({
        name: "Leaky",
        transport: { type: "http", url: "http://example.com/mcp", headers: { Authorization: { kind: "secret", value: "Bearer abcdefgh1234" } } },
        scope: "global",
        workspaceId: null,
        enabled: true,
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(store.db.prepare("SELECT count(*) AS n FROM secrets").get()).toEqual({ n: 0 });
  });

  it("reports a wrong credential as an error status", async () => {
    fixture = await startHttpFixture("Bearer right-secret-000000");
    const added = await service.api().add({
      name: "Remote",
      transport: { type: "http", url: fixture.url, headers: { Authorization: { kind: "secret", value: "Bearer wrong-secret-99999" } } },
      scope: "global",
      workspaceId: null,
      enabled: true,
    });
    const tested = await service.api().test({ serverId: added.config.id });
    expect(tested.status.state).toBe("error");
    expect(tested.status.lastError ?? "").not.toContain("wrong-secret");
  });
});
