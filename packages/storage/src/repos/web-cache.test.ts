import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openNovaStore } from "../nova-store";
import type { NovaStore } from "../types";
import { createWebCacheRepo, createWebSearchUsageRepo, type WebCacheRecord } from "./web-cache";

let store: NovaStore;

beforeEach(() => {
  store = openNovaStore(":memory:");
});
afterEach(() => {
  store.close();
});

const entry = (patch: Partial<WebCacheRecord> = {}): WebCacheRecord => ({
  urlHash: "h1",
  url: "https://docs.example.org/final",
  title: "Doc",
  markdown: "texte",
  contentHash: "c1",
  fetchedAt: 100,
  expiresAt: 200,
  ...patch,
});

describe("web cache repo", () => {
  it("returns an entry until it expires, upserts and purges", () => {
    const repo = createWebCacheRepo(store.db);
    repo.put(entry());
    expect(repo.get("h1", 150)).toEqual(entry());
    expect(repo.get("h1", 200)).toBeNull();
    repo.put(entry({ markdown: "nouveau", expiresAt: 400, title: null }));
    expect(repo.get("h1", 300)).toMatchObject({ markdown: "nouveau", title: null });
    repo.put(entry({ urlHash: "h2", expiresAt: 250 }));
    expect(repo.purgeExpired(300)).toBe(1);
    expect(repo.get("h1", 300)).not.toBeNull();
  });
});

describe("web search usage repo", () => {
  it("records usage with kind web_search, and unknown cost as null", () => {
    const usage = createWebSearchUsageRepo(store.db, () => 42);
    const base = { providerId: "openrouter", modelId: "example/m", servedModel: null, servedProvider: null, conversationId: null, messageId: null, missionId: null, toolCallId: null };
    usage.record({ ...base, usage: { promptTokens: 10, completionTokens: 2, reasoningTokens: null, cachedTokens: null, cost: 0.004 } });
    usage.record({ ...base, usage: null });
    const rows = store.db.prepare("SELECT kind, cost, prompt_tokens, created_at FROM usage_records ORDER BY cost IS NULL").all();
    expect(rows.map((row) => ({ ...row }))).toEqual([
      { kind: "web_search", cost: 0.004, prompt_tokens: 10, created_at: 42 },
      { kind: "web_search", cost: null, prompt_tokens: null, created_at: 42 },
    ]);
  });
});
