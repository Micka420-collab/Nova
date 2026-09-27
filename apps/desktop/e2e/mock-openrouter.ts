// Local stand-in for the OpenRouter API used by E2E tests (no network, no cost).
// Shapes follow the official docs and live captures: /models, /key, streaming /chat/completions.
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";

export const MOCK_KEYS = {
  valid: "sk-or-v1-e2e-valid-00000000000000000000000000000000",
  invalid: "sk-or-v1-e2e-invalid-000000000000000000000000000000",
  noCredit: "sk-or-v1-e2e-nocredit-00000000000000000000000000000",
} as const;

export interface RecordedRequest {
  method: string;
  path: string;
  keyTail: string | null;
  body: unknown;
  aborted: boolean;
}

export interface MockOpenRouter {
  /** Base URL to give NOVA (ends with /api/v1). */
  baseUrl: string;
  requests: RecordedRequest[];
  close(): Promise<void>;
}

const fixturePath = fileURLToPath(
  new URL("../../../packages/providers/src/__fixtures__/openrouter-models.json", import.meta.url),
);

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function bearer(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  return header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface ChatBody {
  model?: string;
  messages?: { role: string; content: string }[];
}

export async function startMockOpenRouter(): Promise<MockOpenRouter> {
  const models = JSON.parse(readFileSync(fixturePath, "utf8")) as { data: unknown[] };
  const requests: RecordedRequest[] = [];
  let replies = 0;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://mock");
    const key = bearer(req);
    const raw = req.method === "POST" ? await readBody(req) : "";
    const record: RecordedRequest = {
      method: req.method ?? "GET",
      path: url.pathname,
      keyTail: key ? key.slice(-4) : null,
      body: raw ? (JSON.parse(raw) as unknown) : null,
      aborted: false,
    };
    requests.push(record);

    if (url.pathname === "/api/v1/models") return json(res, 200, { data: models.data });

    if (key !== MOCK_KEYS.valid && key !== MOCK_KEYS.noCredit) {
      return json(res, 401, { error: { message: "User not found.", code: 401 } });
    }

    if (url.pathname === "/api/v1/key") {
      return json(res, 200, {
        data: {
          label: key === MOCK_KEYS.valid ? "Clé E2E" : "Clé E2E sans crédit",
          limit: 5,
          limit_reset: null,
          limit_remaining: key === MOCK_KEYS.valid ? 4.25 : 0,
          include_byok_in_limit: false,
          usage: 0.75,
          usage_daily: 0.01,
          usage_weekly: 0.2,
          usage_monthly: 0.75,
          byok_usage: 0,
          byok_usage_daily: 0,
          byok_usage_weekly: 0,
          byok_usage_monthly: 0,
          is_free_tier: false,
          free_model_daily_requests: { used: 0, limit: 1000, remaining: 1000 },
        },
      });
    }

    if (url.pathname !== "/api/v1/chat/completions" || req.method !== "POST") {
      return json(res, 404, { error: { message: "Not found", code: 404 } });
    }

    if (key === MOCK_KEYS.noCredit) {
      return json(res, 402, {
        error: { code: 402, message: "Insufficient credits. Add more using https://openrouter.ai/credits" },
      });
    }

    const body = record.body as ChatBody;
    const last = [...(body.messages ?? [])].reverse().find((m) => m.role === "user")?.content ?? "";
    const model = body.model ?? "unknown/model";

    if (last.includes("[429]")) {
      return json(res, 429, { error: { code: 429, message: "Rate limit exceeded" } }, { "retry-after": "7" });
    }
    if (last.includes("[502]")) {
      return json(res, 502, { error: { code: 502, message: "Upstream model is down" } });
    }

    // Set when the client (NOVA) drops the connection before the response ends.
    const client = { gone: false };
    res.on("close", () => {
      if (!res.writableFinished) {
        client.gone = true;
        record.aborted = true;
      }
    });
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const id = `gen-e2e-${++replies}`;
    const send = (payload: unknown) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
    const chunk = (delta: Record<string, string>, finish: string | null = null) =>
      send({ id, model, provider: "MockProvider", choices: [{ index: 0, delta, finish_reason: finish }] });

    res.write(": OPENROUTER PROCESSING\n\n");
    await sleep(80);

    if (last.includes("[reasoning]")) {
      for (let i = 0; i < 5 && !client.gone; i++) {
        chunk({ role: "assistant", content: "", reasoning: "…" });
        await sleep(120);
      }
    }

    if (last.includes("[slow]")) {
      for (let i = 0; i < 300 && !client.gone; i++) {
        chunk({ role: "assistant", content: `mot${i} ` });
        await sleep(100);
      }
      if (!client.gone) res.end("data: [DONE]\n\n");
      return;
    }

    if (last.includes("[midstream-error]")) {
      chunk({ role: "assistant", content: "Début de réponse" });
      await sleep(50);
      send({
        id,
        model,
        error: { code: "server_error", message: "Provider disconnected unexpectedly" },
        choices: [{ index: 0, delta: { content: "" }, finish_reason: "error" }],
      });
      res.end();
      return;
    }

    if (last.includes("[cut]")) {
      chunk({ role: "assistant", content: "Réponse coupée" });
      await sleep(50);
      res.socket?.destroy();
      return;
    }

    const answer = [
      `Bonjour ! Réponse simulée n°${replies}.`,
      "\n\nVoici un exemple :\n\n```ts\nconst nova = \"atelier\";\n```\n",
    ];
    for (const part of answer) {
      for (const piece of part.match(/.{1,12}/gs) ?? []) {
        if (client.gone) return;
        chunk({ role: "assistant", content: piece });
        await sleep(15);
      }
    }
    const usage = {
      prompt_tokens: 42,
      completion_tokens: 17,
      total_tokens: 59,
      cost: 0.0000123,
      prompt_tokens_details: { cached_tokens: 0 },
      completion_tokens_details: { reasoning_tokens: 0 },
    };
    send({ id, model, provider: "MockProvider", choices: [{ index: 0, delta: { content: "" }, finish_reason: "stop" }], usage });
    send({ id, model, provider: "MockProvider", choices: [{ index: 0, delta: { content: "" }, finish_reason: "stop" }], usage });
    res.end("data: [DONE]\n\n");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/api/v1`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
