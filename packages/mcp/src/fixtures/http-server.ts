// Streamable HTTP MCP server for tests (stateless mode of the SDK's server transport), on
// 127.0.0.1 with a random port. Requests without the expected Authorization header get a 401.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

export interface HttpFixture {
  url: string;
  /** Authorization headers received, in order (tests assert the secret reached the server). */
  received: string[];
  close(): Promise<void>;
}

function mcpServer(): Server {
  const server = new Server({ name: "nova-http-fixture", version: "1.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [
      {
        name: "ping",
        description: "Answers pong.",
        inputSchema: { type: "object" },
        annotations: { readOnlyHint: true },
      },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, () => ({ content: [{ type: "text", text: "pong" }] }));
  return server;
}

export async function startHttpFixture(expectedAuthorization: string): Promise<HttpFixture> {
  const received: string[] = [];
  const http = createServer((req: IncomingMessage, res: ServerResponse) => {
    const auth = req.headers.authorization ?? "";
    received.push(auth);
    if (auth !== expectedAuthorization) {
      res.writeHead(401).end();
      return;
    }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const server = mcpServer();
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    void server.connect(transport).then(() => transport.handleRequest(req, res));
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const { port } = http.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    received,
    close: () =>
      new Promise<void>((resolve) => {
        http.closeAllConnections();
        http.close(() => resolve());
      }),
  };
}
