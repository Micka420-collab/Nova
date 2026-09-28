import { afterEach, describe, expect, it } from "vitest";
import { startHttpFixture, type HttpFixture } from "./fixtures/http-server";
import { connectMcpSession, type McpSession, type McpSessionInfo } from "./session";
import { httpTransportFactory } from "./transports";

const AUTH = "Bearer session-secret-123456";

let fixture: HttpFixture | null = null;
let session: McpSession | null = null;

afterEach(async () => {
  await session?.close();
  session = null;
  await fixture?.close();
  fixture = null;
});

/** Connected HTTP session whose fetch answers `failure()` instead of the server once it returns one. */
async function connectHttp(failure: () => Response | Error | null): Promise<{ session: McpSession; states: McpSessionInfo["state"][] }> {
  fixture = await startHttpFixture(AUTH);
  const states: McpSessionInfo["state"][] = [];
  session = await connectMcpSession({
    serverId: "remote",
    createTransport: httpTransportFactory({ url: fixture.url, headers: { Authorization: AUTH } }, async (url, init) => {
      const injected = failure();
      if (injected instanceof Error) throw injected;
      return injected ?? fetch(url, init);
    }),
    onInfo: (info) => states.push(info.state),
  });
  expect(session.info().state).toBe("connected");
  return { session, states };
}

describe("Streamable HTTP session", () => {
  it("drops the connection when the endpoint becomes unreachable, instead of staying connected", async () => {
    let down = false;
    const { session: live, states } = await connectHttp(() => (down ? new TypeError("fetch failed") : null));
    down = true;
    expect(await live.callTool("ping", {})).toMatchObject({ ok: false, code: "unavailable" });
    expect(live.info()).toMatchObject({ state: "error", lastError: "La connexion au serveur a été perdue." });
    expect(states.at(-1)).toBe("error");
  });

  it("drops the connection when the server forgot the session (404)", async () => {
    let expired = false;
    const { session: live } = await connectHttp(() => (expired ? new Response("unknown session", { status: 404 }) : null));
    expired = true;
    expect(await live.callTool("ping", {})).toMatchObject({ ok: false, code: "unavailable" });
    expect(live.info().state).toBe("error");
  });

  it("keeps the connection when one request fails with another HTTP status", async () => {
    let failing = false;
    const { session: live } = await connectHttp(() => (failing ? new Response("boom", { status: 500 }) : null));
    failing = true;
    expect(await live.callTool("ping", {})).toMatchObject({ ok: false, code: "failed" });
    expect(live.info().state).toBe("connected");
    failing = false;
    expect(await live.callTool("ping", {})).toMatchObject({ ok: true, text: "pong" });
  });
});
