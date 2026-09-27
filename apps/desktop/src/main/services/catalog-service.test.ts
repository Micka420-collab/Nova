import { ProviderError, providerErrorInfo } from "@nova/providers";
import type { ModelInfo } from "@nova/shared";
import { openNovaStore, type NovaStore } from "@nova/storage";
import { afterEach, describe, expect, it } from "vitest";
import { CATALOG_MAX_AGE_MS, CatalogService } from "./catalog-service";

function model(id: string): ModelInfo {
  return {
    id,
    name: id,
    author: id.split("/")[0] ?? id,
    description: null,
    contextLength: null,
    maxCompletionTokens: null,
    inputModalities: null,
    outputModalities: null,
    supportsTools: null,
    supportsStructuredOutputs: null,
    supportsReasoning: null,
    pricing: { promptPerMTok: null, completionPerMTok: null, variable: false },
    isFree: false,
    expirationDate: null,
    createdAt: null,
  };
}

const CACHED = [model("author/cached")];
const LIVE = [model("author/live-a"), model("author/live-b")];

class FakeCatalogProvider {
  readonly id = "openrouter" as const;
  readonly calls: { apiKey?: string }[] = [];
  outcome: ModelInfo[] | Error = LIVE;

  async listModels(options: { apiKey?: string } = {}): Promise<ModelInfo[]> {
    this.calls.push(options);
    if (this.outcome instanceof Error) throw this.outcome;
    return this.outcome;
  }
}

const stores: NovaStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

function setup(options: { cachedAt?: number; key?: () => Promise<string | null> } = {}) {
  const store = openNovaStore(":memory:");
  stores.push(store);
  if (options.cachedAt !== undefined) store.saveCatalog("openrouter", CACHED, options.cachedAt);
  const provider = new FakeCatalogProvider();
  const clock = { now: 10 * CATALOG_MAX_AGE_MS };
  const service = new CatalogService({
    store,
    provider,
    resolveApiKey: options.key ?? (async () => null),
    now: () => clock.now,
  });
  return { store, provider, clock, service };
}

describe("CatalogService", () => {
  it("fetches, caches and reports a network catalog when nothing is cached", async () => {
    const { service, store, provider, clock } = setup();
    const catalog = await service.catalog({ refresh: false });

    expect(catalog).toEqual({
      providerId: "openrouter",
      models: LIVE,
      fetchedAt: clock.now,
      source: "network",
      refreshError: null,
    });
    expect(provider.calls).toEqual([{}]);
    expect(store.loadCatalog("openrouter")).toEqual({ models: LIVE, fetchedAt: clock.now });
  });

  it("serves a fresh cache without calling the provider", async () => {
    const now = 10 * CATALOG_MAX_AGE_MS;
    const { service, provider } = setup({ cachedAt: now - CATALOG_MAX_AGE_MS + 1 });
    const catalog = await service.catalog({ refresh: false });

    expect(catalog).toMatchObject({ models: CACHED, source: "cache", refreshError: null });
    expect(provider.calls).toEqual([]);
  });

  it("refetches a stale cache, a cache from the future and on explicit refresh", async () => {
    const now = 10 * CATALOG_MAX_AGE_MS;
    for (const [cachedAt, refresh] of [
      [now - CATALOG_MAX_AGE_MS, false],
      [now + 60_000, false],
      [now - 1, true],
    ] as const) {
      const { service, provider } = setup({ cachedAt });
      await expect(service.catalog({ refresh })).resolves.toMatchObject({ models: LIVE, source: "network" });
      expect(provider.calls).toHaveLength(1);
    }
  });

  it("falls back to the cache with the refresh error when the provider fails", async () => {
    const { service, provider } = setup({ cachedAt: 5 });
    const offline = providerErrorInfo("network", { providerMessage: "getaddrinfo ENOTFOUND" });
    provider.outcome = new ProviderError(offline);

    await expect(service.catalog({ refresh: true })).resolves.toEqual({
      providerId: "openrouter",
      models: CACHED,
      fetchedAt: 5,
      source: "cache",
      refreshError: offline,
    });
  });

  it("throws the provider error when there is no cache to fall back on", async () => {
    const { service, provider } = setup();
    provider.outcome = new ProviderError(providerErrorInfo("timeout"));
    await expect(service.catalog({ refresh: false })).rejects.toMatchObject({ info: { code: "timeout" } });
  });

  it("sends the key when one is available and goes without it when the vault fails", async () => {
    const withKey = setup({ key: async () => "sk-or-v1-catalog-key-000000" });
    await withKey.service.catalog({ refresh: true });
    expect(withKey.provider.calls).toEqual([{ apiKey: "sk-or-v1-catalog-key-000000" }]);

    const vaultDown = setup({ key: () => Promise.reject(new Error("vault locked")) });
    await expect(vaultDown.service.catalog({ refresh: true })).resolves.toMatchObject({ source: "network" });
    expect(vaultDown.provider.calls).toEqual([{}]);
  });
});
